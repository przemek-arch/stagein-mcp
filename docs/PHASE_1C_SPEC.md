# StageIn MCP — Phase 1C OAuth 2.1 Bridge — Technical Specification

**Status:** Ready for implementation
**Strategy:** B — three sequential PRs (1C-1, 1C-2, 1C-3)
**Prerequisites:** Phases 1A (DB migrations) and 1B (Edge Function skeleton) complete and verified
**Estimated effort:** ~3-4 hours of focused work spread across 3 sessions
**Author context:** This spec was prepared by Claude Opus 4.7 after completing Phase 1B verification

---

## 0. Why this exists

The MCP server we built in Phase 1B accepts unauthenticated requests. That's fine for development but unacceptable for production for three reasons:

1. **Rate limiting needs identity.** Without a way to identify clients, abusive actors can hammer the server anonymously.
2. **User context for write tools.** Phase 2 includes tools like `track_price`, `follow_artist`, `subscribe_newsletter` — they need to know *who* is asking.
3. **Submission directories require it.** Anthropic Connectors Directory, OpenAI ChatGPT Apps, and Smithery all favor (or require) authenticated MCP servers.

Phase 1C closes that gap by implementing OAuth 2.1 with Dynamic Client Registration (RFC 7591), PKCE (RFC 7636), and a Supabase Auth magic-link bridge for the user authentication step.

---

## 1. Architecture overview

```
                                      MCP CLIENT
                              (Claude.ai / ChatGPT / Cursor)
                                          │
              ┌───────────────────────────┼─────────────────────────────┐
              │                           │                             │
              ▼                           ▼                             ▼
        DISCOVERY                 AUTHORIZATION                    TOKEN
   GET /.well-known/        GET /oauth/authorize             POST /oauth/token
   oauth-authorization-     ↓ (redirect to Supabase)         ↓ (verify code+PKCE)
   server                   GET /oauth/callback              return JWT access_token
                            ↓ (verify session, issue code)
                            redirect back to client
                                          │
                                          ▼
                                  AUTHENTICATED MCP CALLS
                                  POST /mcp
                                  Authorization: Bearer <jwt>
```

Three parallel surfaces:

| Surface | Purpose | Endpoints |
|---|---|---|
| **Discovery** | Tells clients where everything is | `GET /.well-known/oauth-authorization-server`<br>`GET /.well-known/oauth-protected-resource` |
| **Registration** | Lets clients dynamically register without manual setup | `POST /oauth/register` |
| **Authorization flow** | Three-legged OAuth with PKCE + magic-link user auth | `GET /oauth/authorize` → `GET /oauth/callback` → `POST /oauth/token` |
| **Resource protection** | Validates JWT on every MCP request | Bearer middleware on `POST /mcp` |

---

## 2. Strategy B rationale

We split into three PRs because failure surface matters:

- **PR 1C-1** (Discovery + DCR) is **isolated** — no external dependencies, no Supabase Auth integration, just DB writes and JSON responses. If something breaks here, it's our code, easy fix.
- **PR 1C-2** (Authorize + callback) integrates **Supabase Auth magic-link** — this is the highest-risk surface because Supabase Auth has quirks (redirect URLs, session formats, OTP tokens) that we'll discover empirically. Isolating it lets us iterate without touching working DCR code.
- **PR 1C-3** (Token + PKCE + JWT) is the **crypto-heavy** part — JWT signing, PKCE verification, code reuse prevention. Worth its own focused review.

Alternative (one big PR) would be 30% faster to write but 3× harder to debug if something goes sideways. We learned in Phase 1B (the routing 404) that small surface area + immediate verification is the winning pattern.

---

## 3. Pre-flight checklist (do before starting)

Before kicking off PR 1C-1, verify:

```bash
# 1. On main, latest pulled
git checkout main
git pull origin main

# 2. Production state confirmed
curl -sS https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp/health
# Expected: HTTP 200, JSON status:ok

# 3. OAuth tables exist (run via Supabase MCP or psql)
SELECT count(*) FROM mcp_oauth_clients;  -- expected: 0
SELECT count(*) FROM mcp_oauth_codes;    -- expected: 0

# 4. Supabase Auth enabled in project
# Dashboard → Authentication → Providers → Email (magic link) ON

# 5. Email templates configured
# Dashboard → Authentication → Email Templates → Magic Link
# (Default template OK for now — we'll polish branding in later phase)
```

If any of these fail, fix before proceeding.

---

## 4. Issuer URL convention

This is critical and we lock it in now:

**Issuer URL:** `https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp`

(no trailing slash, no `mcp.stagein.pl` yet — custom domain mapping deferred until after 1C is verified working)

All OAuth metadata, JWT `iss` claim, and audience checks reference this exact string. When custom domain is added later, we'll do a single migration: update issuer in code, regenerate any cached metadata, communicate to registered clients (most will rediscover automatically via `.well-known`).

---

# PHASE 1C-1: Discovery + Dynamic Client Registration

## 1C-1.1 Goal

Implement two `.well-known` discovery endpoints and the `POST /oauth/register` endpoint. After this PR, MCP clients can discover the server's OAuth capabilities and register themselves dynamically — but they can't yet authenticate users (that comes in 1C-2) or get tokens (1C-3).

## 1C-1.2 Files to create/modify

```
supabase/functions/mcp/
├── index.ts                     # MODIFY — mount oauth routes
├── lib/
│   └── issuer.ts                # NEW — issuer URL constant
└── oauth/
    ├── types.ts                 # NEW — shared TypeScript types
    ├── discovery.ts             # NEW — .well-known handlers
    └── register.ts              # NEW — DCR handler
```

## 1C-1.3 `lib/issuer.ts`

```ts
// Single source of truth for the OAuth issuer URL.
// When custom domain mcp.stagein.pl is configured in Phase 1D,
// flip this to "https://mcp.stagein.pl" (no /functions/v1/mcp suffix).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const PROJECT_REF = SUPABASE_URL.replace("https://", "").split(".")[0];

export const ISSUER = `https://${PROJECT_REF}.supabase.co/functions/v1/mcp`;
export const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/authorize`;
export const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
export const REGISTRATION_ENDPOINT = `${ISSUER}/oauth/register`;
```

## 1C-1.4 `oauth/types.ts`

```ts
import { z } from "zod";

// RFC 7591 — Dynamic Client Registration request
export const ClientRegistrationRequest = z.object({
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string().email()).max(5).optional(),
  tos_uri: z.string().url().optional(),
  policy_uri: z.string().url().optional(),
  grant_types: z.array(z.literal("authorization_code")).optional(),
  response_types: z.array(z.literal("code")).optional(),
  token_endpoint_auth_method: z.enum(["client_secret_post", "none"]).optional(),
});

export type ClientRegistrationRequest = z.infer<typeof ClientRegistrationRequest>;

// RFC 7591 — Dynamic Client Registration response
export interface ClientRegistrationResponse {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  grant_types: ["authorization_code"];
  response_types: ["code"];
  token_endpoint_auth_method: "client_secret_post";
}

// RFC 6749 — OAuth error response (used in all OAuth endpoints)
export interface OAuthError {
  error: string;
  error_description?: string;
  error_uri?: string;
}
```

## 1C-1.5 `oauth/discovery.ts`

```ts
import type { Context } from "hono";
import {
  AUTHORIZATION_ENDPOINT,
  ISSUER,
  REGISTRATION_ENDPOINT,
  TOKEN_ENDPOINT,
} from "../lib/issuer.ts";

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 * Cached for 1h client-side per spec recommendation.
 */
export function authorizationServerMetadata(c: Context) {
  return c.json({
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    registration_endpoint: REGISTRATION_ENDPOINT,
    scopes_supported: ["mcp.read", "mcp.write"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://stagein.pl/mcp",
  }, 200, { "Cache-Control": "public, max-age=3600" });
}

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 * Tells MCP clients which authorization servers can issue valid tokens for this resource.
 * Required by MCP Authorization spec (2025-06-18).
 */
export function protectedResourceMetadata(c: Context) {
  return c.json({
    resource: ISSUER,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://stagein.pl/mcp",
    resource_signing_alg_values_supported: ["HS256"],
  }, 200, { "Cache-Control": "public, max-age=3600" });
}
```

## 1C-1.6 `oauth/register.ts`

```ts
import type { Context } from "hono";
import { admin } from "../lib/supabase.ts";
import { ClientRegistrationRequest, type ClientRegistrationResponse } from "./types.ts";

/**
 * RFC 7591 — Dynamic Client Registration.
 * Public endpoint, no auth required (intentional — that's the whole point of DCR).
 * Rate limiting is the responsibility of the caller infrastructure (Phase 3 hardening).
 */
export async function registerClient(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      error: "invalid_request",
      error_description: "Request body must be valid JSON",
    }, 400);
  }

  const parsed = ClientRegistrationRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "invalid_client_metadata",
      error_description: parsed.error.issues[0]?.message ?? "Invalid client metadata",
    }, 400);
  }

  // Validate redirect_uris: must be HTTPS or localhost (RFC 8252 — Native Apps)
  for (const uri of parsed.data.redirect_uris) {
    const url = new URL(uri);
    const isHttps = url.protocol === "https:";
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!isHttps && !isLoopback) {
      return c.json({
        error: "invalid_redirect_uri",
        error_description: `redirect_uri must use HTTPS or be a loopback address: ${uri}`,
      }, 400);
    }
  }

  // Generate client credentials
  const clientSecret = generateClientSecret();
  const issuedAt = Math.floor(Date.now() / 1000);

  // Insert into mcp_oauth_clients
  const { data, error } = await admin().from("mcp_oauth_clients").insert({
    client_secret: clientSecret,
    client_name: parsed.data.client_name,
    redirect_uris: parsed.data.redirect_uris,
    client_uri: parsed.data.client_uri ?? null,
    logo_uri: parsed.data.logo_uri ?? null,
    scope: parsed.data.scope ?? "mcp.read mcp.write",
    contacts: parsed.data.contacts ?? null,
    tos_uri: parsed.data.tos_uri ?? null,
    policy_uri: parsed.data.policy_uri ?? null,
  }).select("client_id").single();

  if (error || !data) {
    console.error("[oauth/register] DB insert failed:", error);
    return c.json({
      error: "server_error",
      error_description: "Failed to register client",
    }, 500);
  }

  const response: ClientRegistrationResponse = {
    client_id: data.client_id,
    client_secret: clientSecret,
    client_id_issued_at: issuedAt,
    client_name: parsed.data.client_name,
    redirect_uris: parsed.data.redirect_uris,
    client_uri: parsed.data.client_uri,
    logo_uri: parsed.data.logo_uri,
    scope: parsed.data.scope ?? "mcp.read mcp.write",
    contacts: parsed.data.contacts,
    tos_uri: parsed.data.tos_uri,
    policy_uri: parsed.data.policy_uri,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };

  return c.json(response, 201);
}

/**
 * Generates a 32-byte cryptographically random client secret,
 * encoded as base64url (no padding).
 */
function generateClientSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
```

## 1C-1.7 `index.ts` modifications

Add after existing imports:

```ts
import { authorizationServerMetadata, protectedResourceMetadata } from "./oauth/discovery.ts";
import { registerClient } from "./oauth/register.ts";
```

Add routes (after `/manifest`, before MCP handler):

```ts
// OAuth 2.1 discovery endpoints (RFC 8414, RFC 9728)
app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);

// OAuth 2.1 Dynamic Client Registration (RFC 7591)
app.post("/oauth/register", registerClient);
```

## 1C-1.8 Test plan for PR 1C-1

After deploy, run from any terminal:

```bash
ISSUER="https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp"

# Test 1: Authorization Server Metadata
echo "=== /.well-known/oauth-authorization-server ===" && \
curl -sS "$ISSUER/.well-known/oauth-authorization-server" | python3 -m json.tool

# Test 2: Protected Resource Metadata
echo "=== /.well-known/oauth-protected-resource ===" && \
curl -sS "$ISSUER/.well-known/oauth-protected-resource" | python3 -m json.tool

# Test 3: DCR with valid input
echo "=== POST /oauth/register (valid) ===" && \
curl -sS -X POST "$ISSUER/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Test Client",
    "redirect_uris": ["https://example.com/callback"],
    "scope": "mcp.read mcp.write"
  }' \
  -w "\nHTTP %{http_code}\n" | python3 -m json.tool

# Test 4: DCR with invalid redirect_uri (should 400)
echo "=== POST /oauth/register (http not allowed) ===" && \
curl -sS -X POST "$ISSUER/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Bad Client",
    "redirect_uris": ["http://insecure.com/callback"]
  }' \
  -w "\nHTTP %{http_code}\n"

# Test 5: DCR with localhost (should succeed)
echo "=== POST /oauth/register (localhost OK) ===" && \
curl -sS -X POST "$ISSUER/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Local Dev",
    "redirect_uris": ["http://localhost:8080/callback"]
  }' \
  -w "\nHTTP %{http_code}\n"

# Test 6: DCR with empty body (should 400)
echo "=== POST /oauth/register (empty body) ===" && \
curl -sS -X POST "$ISSUER/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w "\nHTTP %{http_code}\n"
```

Then verify DB state via Supabase MCP:

```sql
SELECT client_id, client_name, redirect_uris, created_at FROM mcp_oauth_clients;
-- Expected: 2 rows (Test Client, Local Dev) — Bad Client should NOT appear
```

## 1C-1.9 Acceptance criteria for PR 1C-1

- [ ] Both `.well-known` endpoints return valid JSON with `issuer` matching `${SUPABASE_URL}/functions/v1/mcp`
- [ ] `Cache-Control: public, max-age=3600` header on both `.well-known` responses
- [ ] DCR with valid HTTPS redirect_uri returns 201 with full client metadata including `client_id` and `client_secret`
- [ ] DCR with localhost redirect_uri returns 201
- [ ] DCR with HTTP (non-localhost) redirect_uri returns 400 with `invalid_redirect_uri` error code
- [ ] DCR with empty body returns 400 with `invalid_client_metadata` error code
- [ ] DB row created in `mcp_oauth_clients` for each successful registration
- [ ] `client_secret` is 43+ characters, base64url-safe alphabet
- [ ] Existing endpoints (`/health`, `/health/deep`, `/manifest`, MCP `/`) continue to work

---

# PHASE 1C-2: Authorize + Callback (Supabase Auth bridge)

## 1C-2.1 Goal

Implement the user-facing authorization flow. After this PR, a user can:
1. Click "Connect StageIn" in their MCP client
2. Get redirected to `/oauth/authorize`
3. Receive a magic-link email
4. Click the link
5. Be redirected back to the MCP client with an authorization code

This is the highest-risk PR because it integrates with Supabase Auth's email + redirect flow, which has subtle behaviors.

## 1C-2.2 Architecture decisions

**Decision A: Where does the user enter their email?**

We can't show an HTML form from the Edge Function easily (would need template engine, not worth it). Two options:

1. Render a minimal HTML form inline in the Edge Function response
2. Redirect to a static page on stagein.pl/mcp/login that posts back to our function

**Choice: Option 1 (inline HTML).** Simpler, no cross-origin complexity, no extra deployment. Form is ~50 lines of HTML, security-focused (CSRF token in hidden field).

**Decision B: How do we preserve OAuth state across the email roundtrip?**

The user clicks the magic link in their email — that opens a new browser tab/window. We need to know which OAuth flow they were in (which `client_id`, what `code_challenge`, what `redirect_uri`).

**Choice: Encode state in a server-side stored token.** When user submits email, we generate a random `state_token`, write `{client_id, redirect_uri, code_challenge, code_challenge_method, scope, client_state}` to a new `mcp_oauth_authorize_state` table with 10 min TTL, and pass `state_token` as the `redirect_to` parameter to Supabase magic-link. When magic-link callback fires, we look up state by token.

This requires a new table — see migration spec below.

**Decision C: How do we use Supabase Auth from server-side?**

Supabase Auth supports `signInWithOtp({ email, options: { emailRedirectTo } })` from the server side using service_role key. We use this to send the magic link.

The `emailRedirectTo` must point to our `/oauth/callback` endpoint with the `state_token` as a query parameter. The user's email link → Supabase Auth → our callback (with Supabase session token) → our authorization code → redirect to MCP client.

## 1C-2.3 Pre-PR DB migration

Apply via Supabase MCP `apply_migration` (NOT db push) before PR work:

```sql
-- Migration: 20260501000000_oauth_authorize_state.sql
-- Phase 1C-2 — server-side state storage for OAuth authorize flow
-- Bridges the email roundtrip in magic-link auth

CREATE TABLE IF NOT EXISTS public.mcp_oauth_authorize_state (
  state_token text PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL CHECK (code_challenge_method IN ('S256')),
  scope text,
  client_state text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);

CREATE INDEX idx_mcp_oauth_authorize_state_expires
  ON public.mcp_oauth_authorize_state(expires_at);

ALTER TABLE public.mcp_oauth_authorize_state ENABLE ROW LEVEL SECURITY;

-- Cleanup expired states hourly
CREATE OR REPLACE FUNCTION public.cleanup_mcp_oauth_authorize_state()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.mcp_oauth_authorize_state
  WHERE expires_at < now() - interval '1 hour';
$$;

SELECT cron.schedule(
  'cleanup-mcp-oauth-authorize-state',
  '0 * * * *',
  $$SELECT public.cleanup_mcp_oauth_authorize_state()$$
);

COMMENT ON TABLE public.mcp_oauth_authorize_state IS
  'Server-side state storage for OAuth authorize flow. Bridges email magic-link roundtrip. 10 min TTL, cleaned hourly.';
```

## 1C-2.4 Files to create/modify

```
supabase/functions/mcp/
├── index.ts                     # MODIFY — mount /oauth/authorize, /oauth/callback
└── oauth/
    ├── authorize.ts             # NEW — GET /oauth/authorize handler
    ├── callback.ts              # NEW — GET /oauth/callback handler
    ├── state.ts                 # NEW — state token storage helpers
    └── login_form.ts            # NEW — inline HTML for email entry
```

## 1C-2.5 `oauth/state.ts`

```ts
import { admin } from "../lib/supabase.ts";

export interface AuthorizeState {
  state_token: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  scope: string | null;
  client_state: string | null;
}

export function generateStateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function storeState(state: AuthorizeState): Promise<void> {
  const { error } = await admin().from("mcp_oauth_authorize_state").insert({
    state_token: state.state_token,
    client_id: state.client_id,
    redirect_uri: state.redirect_uri,
    code_challenge: state.code_challenge,
    code_challenge_method: state.code_challenge_method,
    scope: state.scope,
    client_state: state.client_state,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) throw new Error(`Failed to store authorize state: ${error.message}`);
}

export async function consumeState(state_token: string): Promise<AuthorizeState | null> {
  const { data, error } = await admin()
    .from("mcp_oauth_authorize_state")
    .select("*")
    .eq("state_token", state_token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;

  // Single-use — delete after read
  await admin().from("mcp_oauth_authorize_state").delete().eq("state_token", state_token);

  return {
    state_token: data.state_token,
    client_id: data.client_id,
    redirect_uri: data.redirect_uri,
    code_challenge: data.code_challenge,
    code_challenge_method: data.code_challenge_method,
    scope: data.scope,
    client_state: data.client_state,
  };
}
```

## 1C-2.6 `oauth/login_form.ts`

```ts
export function loginFormHtml(stateToken: string, clientName: string): string {
  // Minimal, brand-aligned, accessible. CSP-compliant inline styles.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to StageIn</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0a0a0a;
    color: #fff;
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 0;
    padding: 2.5rem;
    max-width: 28rem;
    width: 100%;
  }
  h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 0.5rem; letter-spacing: -0.02em; }
  .sub { color: #888; font-size: 0.875rem; margin-bottom: 1.75rem; }
  .client { color: #C62B0A; font-weight: 600; }
  label { display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: #ccc; }
  input[type="email"] {
    width: 100%;
    padding: 0.75rem 1rem;
    background: #0a0a0a;
    border: 1px solid #2a2a2a;
    color: #fff;
    font-size: 1rem;
    box-sizing: border-box;
    margin-bottom: 1.25rem;
  }
  input[type="email"]:focus { outline: none; border-color: #C62B0A; }
  button {
    width: 100%;
    padding: 0.85rem;
    background: #C62B0A;
    color: #fff;
    border: none;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  button:hover { background: #a62308; }
  .legal { color: #666; font-size: 0.75rem; margin-top: 1.5rem; line-height: 1.5; }
  .legal a { color: #888; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect to StageIn</h1>
    <p class="sub"><span class="client">${escapeHtml(clientName)}</span> wants to access StageIn data on your behalf.</p>
    <form method="POST" action="/mcp/oauth/authorize/email">
      <input type="hidden" name="state_token" value="${escapeHtml(stateToken)}">
      <label for="email">Your email address</label>
      <input id="email" type="email" name="email" required autofocus placeholder="you@example.com">
      <button type="submit">Send sign-in link</button>
    </form>
    <p class="legal">
      You'll receive a one-time sign-in link by email.
      By continuing you agree to our <a href="https://stagein.pl/terms">Terms</a> and
      <a href="https://stagein.pl/privacy">Privacy Policy</a>.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
```

## 1C-2.7 `oauth/authorize.ts`

```ts
import type { Context } from "hono";
import { admin } from "../lib/supabase.ts";
import { ISSUER } from "../lib/issuer.ts";
import { generateStateToken, storeState } from "./state.ts";
import { loginFormHtml } from "./login_form.ts";

/**
 * GET /oauth/authorize
 * Validates the auth request, stores state, renders email entry form.
 */
export async function authorize(c: Context) {
  const url = new URL(c.req.url);
  const params = url.searchParams;

  const response_type = params.get("response_type");
  const client_id = params.get("client_id");
  const redirect_uri = params.get("redirect_uri");
  const code_challenge = params.get("code_challenge");
  const code_challenge_method = params.get("code_challenge_method");
  const scope = params.get("scope");
  const client_state = params.get("state");

  // Validate response_type
  if (response_type !== "code") {
    return c.json({ error: "unsupported_response_type" }, 400);
  }

  // Validate required params
  if (!client_id || !redirect_uri || !code_challenge || !code_challenge_method) {
    return c.json({
      error: "invalid_request",
      error_description: "Missing required parameter (client_id, redirect_uri, code_challenge, code_challenge_method)",
    }, 400);
  }

  // PKCE method must be S256 (plain explicitly disallowed for security)
  if (code_challenge_method !== "S256") {
    return c.json({
      error: "invalid_request",
      error_description: "Only S256 code_challenge_method is supported",
    }, 400);
  }

  // Validate code_challenge format (43-128 chars, base64url alphabet)
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge)) {
    return c.json({
      error: "invalid_request",
      error_description: "Invalid code_challenge format",
    }, 400);
  }

  // Look up client and verify redirect_uri matches a registered one
  const { data: client, error: clientErr } = await admin()
    .from("mcp_oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", client_id)
    .maybeSingle();

  if (clientErr || !client) {
    return c.json({
      error: "invalid_client",
      error_description: "Unknown client_id",
    }, 400);
  }

  if (!client.redirect_uris.includes(redirect_uri)) {
    return c.json({
      error: "invalid_redirect_uri",
      error_description: "redirect_uri does not match any registered URI for this client",
    }, 400);
  }

  // Store state
  const state_token = generateStateToken();
  await storeState({
    state_token,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method: "S256",
    scope: scope ?? "mcp.read mcp.write",
    client_state: client_state ?? null,
  });

  // Render email entry form
  return c.html(loginFormHtml(state_token, client.client_name ?? "An MCP client"));
}

/**
 * POST /oauth/authorize/email
 * Receives email from form, sends Supabase magic link.
 */
export async function submitEmail(c: Context) {
  const formData = await c.req.formData();
  const state_token = formData.get("state_token");
  const email = formData.get("email");

  if (!state_token || typeof state_token !== "string" || !email || typeof email !== "string") {
    return c.json({ error: "invalid_request" }, 400);
  }

  // Verify state exists and not expired (without consuming — we need it after the email click)
  const { data: state } = await admin()
    .from("mcp_oauth_authorize_state")
    .select("client_id")
    .eq("state_token", state_token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!state) {
    return c.html("<h1>Session expired</h1><p>Please restart the authorization flow.</p>", 400);
  }

  // Trigger Supabase magic link
  const callbackUrl = `${ISSUER}/oauth/callback?state_token=${encodeURIComponent(state_token)}`;

  const { error } = await admin().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: callbackUrl,
    },
  });

  if (error) {
    console.error("[oauth/authorize] signInWithOtp failed:", error);
    return c.html("<h1>Could not send email</h1><p>Please try again later.</p>", 500);
  }

  return c.html(`<!DOCTYPE html><html><head><title>Check your email</title>
    <style>body{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem;text-align:center}h1{font-size:1.5rem}p{color:#888;max-width:24rem;line-height:1.6}</style>
    </head><body><div><h1>Check your email</h1>
    <p>We sent a sign-in link to <strong>${escapeHtml(email)}</strong>. Click it to complete the connection. You can close this tab.</p>
    </div></body></html>`);
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
```

## 1C-2.8 `oauth/callback.ts`

```ts
import type { Context } from "hono";
import { admin } from "../lib/supabase.ts";
import { consumeState } from "./state.ts";

/**
 * GET /oauth/callback?state_token=...&access_token=...&token_type=bearer&...
 * Receives the user back from Supabase Auth magic link.
 * Verifies session, generates authorization code, redirects to client.
 */
export async function callback(c: Context) {
  const url = new URL(c.req.url);
  const state_token = url.searchParams.get("state_token");

  // Supabase Auth puts tokens in the URL fragment (#access_token=...) by default,
  // but with emailRedirectTo it puts them in query for non-PKCE flow.
  // We rely on the access_token query param for server-side verification.
  const access_token = url.searchParams.get("access_token");

  if (!state_token) {
    return c.html("<h1>Invalid callback</h1><p>Missing state token.</p>", 400);
  }

  if (!access_token) {
    // Fragment-based response — show a small JS shim that re-issues the request with query params
    return c.html(`<!DOCTYPE html><html><body><script>
      const params = new URLSearchParams(window.location.hash.slice(1));
      const stateToken = new URLSearchParams(window.location.search).get("state_token");
      params.set("state_token", stateToken);
      window.location.replace(window.location.pathname + "?" + params.toString());
    </script><noscript>JavaScript required to complete sign-in.</noscript></body></html>`);
  }

  // Verify the access token belongs to a real Supabase user
  const { data: userData, error: userErr } = await admin().auth.getUser(access_token);
  if (userErr || !userData.user) {
    return c.html("<h1>Invalid session</h1><p>Sign-in failed. Please try again.</p>", 401);
  }

  // Consume state (single-use)
  const state = await consumeState(state_token);
  if (!state) {
    return c.html("<h1>Session expired</h1><p>The authorization flow expired or was already used.</p>", 400);
  }

  // Generate authorization code
  const code = generateAuthCode();
  const { error: codeErr } = await admin().from("mcp_oauth_codes").insert({
    code,
    client_id: state.client_id,
    user_id: userData.user.id,
    redirect_uri: state.redirect_uri,
    code_challenge: state.code_challenge,
    code_challenge_method: state.code_challenge_method,
    scope: state.scope,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (codeErr) {
    console.error("[oauth/callback] failed to store code:", codeErr);
    return c.html("<h1>Server error</h1><p>Please try again.</p>", 500);
  }

  // Build redirect URL with code and original client state
  const redirectUrl = new URL(state.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state.client_state) {
    redirectUrl.searchParams.set("state", state.client_state);
  }

  return c.redirect(redirectUrl.toString(), 302);
}

function generateAuthCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
```

## 1C-2.9 `index.ts` modifications

Add imports:

```ts
import { authorize, submitEmail } from "./oauth/authorize.ts";
import { callback } from "./oauth/callback.ts";
```

Add routes:

```ts
app.get("/oauth/authorize", authorize);
app.post("/oauth/authorize/email", submitEmail);
app.get("/oauth/callback", callback);
```

## 1C-2.10 Test plan for PR 1C-2

This phase is hard to test purely via curl because the flow involves a real email roundtrip. Two-stage test:

**Stage 1: Curl-only (no real email):**

```bash
ISSUER="https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp"

# First, register a client (from PR 1C-1)
CLIENT_DATA=$(curl -sS -X POST "$ISSUER/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"E2E Test","redirect_uris":["https://localhost:8443/cb"]}')

CLIENT_ID=$(echo "$CLIENT_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])")
echo "Registered client: $CLIENT_ID"

# Generate PKCE pair
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr "+/" "-_" | tr -d "=")
echo "code_verifier: $CODE_VERIFIER"
echo "code_challenge: $CODE_CHALLENGE"

# Authorize endpoint should render HTML form (HTTP 200, content-type text/html)
echo "=== GET /oauth/authorize ==="
curl -sS -o /tmp/auth.html -w "HTTP %{http_code}\n" \
  "$ISSUER/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https://localhost:8443/cb&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&state=client-csrf-123"

# Verify form has state_token
grep -o 'state_token" value="[^"]*"' /tmp/auth.html

# Test bad client_id
echo "=== Bad client_id ==="
curl -sS -w "HTTP %{http_code}\n" \
  "$ISSUER/oauth/authorize?response_type=code&client_id=00000000-0000-0000-0000-000000000000&redirect_uri=https://x.com&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# Test bad redirect_uri (not registered)
echo "=== Mismatched redirect_uri ==="
curl -sS -w "HTTP %{http_code}\n" \
  "$ISSUER/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https://evil.com/cb&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# Test plain method (should fail, S256 only)
echo "=== plain method rejected ==="
curl -sS -w "HTTP %{http_code}\n" \
  "$ISSUER/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https://localhost:8443/cb&code_challenge=plaintext&code_challenge_method=plain"
```

**Stage 2: Real email flow (manual, end-to-end):**

1. Visit `$ISSUER/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https://localhost:8443/cb&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&state=test123` in a browser
2. See login form, enter your real email
3. Submit, see "Check your email" page
4. Open email, click link
5. Verify redirect to `https://localhost:8443/cb?code=XYZ&state=test123` (browser will show connection refused, that's fine — copy the URL)
6. Extract `code` from URL — that's the authorization code
7. Verify in DB: `SELECT * FROM mcp_oauth_codes WHERE code='XYZ'` — should show one row, `expires_at` ~10 min ahead

Save the `code` and `code_verifier` for testing PR 1C-3.

## 1C-2.11 Acceptance criteria for PR 1C-2

- [ ] `GET /oauth/authorize` with valid params returns HTML form (200, `text/html`)
- [ ] HTML form contains `state_token` hidden input
- [ ] Invalid `client_id` returns 400
- [ ] Mismatched `redirect_uri` returns 400 with `invalid_redirect_uri`
- [ ] `code_challenge_method=plain` returns 400
- [ ] Malformed `code_challenge` returns 400
- [ ] `POST /oauth/authorize/email` with valid email triggers magic link send
- [ ] Email lands in inbox within 60 seconds
- [ ] Magic link click results in redirect to `redirect_uri` with `code` and original `state` query parameters
- [ ] DB row created in `mcp_oauth_codes` with all fields populated
- [ ] State row deleted from `mcp_oauth_authorize_state` after callback (single-use)
- [ ] Replay attack prevention: clicking same magic link twice fails on second attempt

---

# PHASE 1C-3: Token Exchange + JWT Issuance + Bearer Middleware

## 1C-3.1 Goal

Implement the final OAuth leg: client exchanges authorization code for an access token, then uses that token to authenticate MCP requests. After this PR, the entire OAuth 2.1 flow works end-to-end.

## 1C-3.2 Files to create/modify

```
supabase/functions/mcp/
├── index.ts                     # MODIFY — apply bearer middleware to MCP route
└── oauth/
    ├── pkce.ts                  # NEW — PKCE verification
    ├── jwt.ts                   # NEW — JWT signing and verification
    ├── token.ts                 # NEW — POST /oauth/token handler
    └── middleware.ts            # NEW — bearer auth middleware
```

## 1C-3.3 `oauth/pkce.ts`

```ts
/**
 * Verifies PKCE code_verifier against code_challenge per RFC 7636.
 * Only S256 method supported (plain is deprecated and disabled in our authorize flow).
 */
export async function verifyPkce(
  code_verifier: string,
  code_challenge: string,
  method: string,
): Promise<boolean> {
  if (method !== "S256") return false;

  // Verifier must be 43-128 chars, base64url alphabet
  if (!/^[A-Za-z0-9_\-.~]{43,128}$/.test(code_verifier)) return false;

  const encoder = new TextEncoder();
  const data = encoder.encode(code_verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const computed = base64urlEncode(new Uint8Array(hash));

  // Constant-time comparison
  return constantTimeEqual(computed, code_challenge);
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
```

## 1C-3.4 `oauth/jwt.ts`

```ts
import { ISSUER } from "../lib/issuer.ts";

/**
 * MCP access token claims.
 * Uses HS256 signed by MCP_JWT_SECRET (set manually in Supabase Dashboard → Settings → Edge Functions → Secrets).
 * Independent of Supabase Auth tokens — separate trust domain.
 */
export interface AccessTokenClaims {
  iss: string;          // issuer URL
  sub: string;          // user_id (Supabase auth.users.id)
  aud: string;          // resource server (same as iss for our setup)
  client_id: string;    // OAuth client that initiated the auth
  scope: string;        // space-separated scopes
  iat: number;          // issued at (unix seconds)
  exp: number;          // expiration (unix seconds)
}

const TOKEN_TTL_SECONDS = 3600; // 1 hour

export async function signAccessToken(params: {
  user_id: string;
  client_id: string;
  scope: string;
}): Promise<{ token: string; expires_in: number }> {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    iss: ISSUER,
    sub: params.user_id,
    aud: ISSUER,
    client_id: params.client_id,
    scope: params.scope,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const signatureB64 = base64urlEncode(new Uint8Array(signature));

  return {
    token: `${signingInput}.${signatureB64}`,
    expires_in: TOKEN_TTL_SECONDS,
  };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify signature
  const key = await getKey();
  const signature = base64urlDecode(signatureB64);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
  if (!valid) return null;

  // Parse and validate claims
  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  } catch {
    return null;
  }

  // Verify required claims
  if (claims.iss !== ISSUER) return null;
  if (claims.aud !== ISSUER) return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) return null;
  if (claims.iat > now + 60) return null; // small clock skew tolerance

  return claims;
}

let _key: CryptoKey | null = null;
async function getKey(): Promise<CryptoKey> {
  if (_key) return _key;
  const secret = Deno.env.get("MCP_JWT_SECRET");
  if (!secret) throw new Error("MCP_JWT_SECRET not available in env. Set it in Supabase Dashboard → Settings → Edge Functions → Secrets.");
  _key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return _key;
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

> **Erratum (2026-05-04):** Original spec assumed `SUPABASE_JWT_SECRET` was auto-injected by Supabase Edge Functions. Per official docs (https://supabase.com/docs/guides/functions/secrets), only `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` are auto-injected. JWT secret must be set manually as `MCP_JWT_SECRET` in Supabase Dashboard → Settings → Edge Functions → Secrets. Discovered during Phase 1C-3 Stage 1 testing.

## 1C-3.5 `oauth/token.ts`

```ts
import type { Context } from "hono";
import { admin } from "../lib/supabase.ts";
import { verifyPkce } from "./pkce.ts";
import { signAccessToken } from "./jwt.ts";

/**
 * POST /oauth/token
 * Exchanges authorization_code for access_token.
 * Implements RFC 6749 §4.1.3 + RFC 7636 (PKCE).
 */
export async function tokenExchange(c: Context) {
  let body: URLSearchParams;
  try {
    const text = await c.req.text();
    body = new URLSearchParams(text);
  } catch {
    return tokenError(c, "invalid_request", "Body must be application/x-www-form-urlencoded");
  }

  const grant_type = body.get("grant_type");
  if (grant_type !== "authorization_code") {
    return tokenError(c, "unsupported_grant_type");
  }

  const code = body.get("code");
  const client_id = body.get("client_id");
  const client_secret = body.get("client_secret");
  const redirect_uri = body.get("redirect_uri");
  const code_verifier = body.get("code_verifier");

  if (!code || !client_id || !redirect_uri || !code_verifier) {
    return tokenError(c, "invalid_request", "Missing required parameter");
  }

  // Verify client credentials
  const { data: client } = await admin()
    .from("mcp_oauth_clients")
    .select("client_id, client_secret")
    .eq("client_id", client_id)
    .maybeSingle();

  if (!client) {
    return tokenError(c, "invalid_client");
  }

  // For confidential clients (token_endpoint_auth_method=client_secret_post)
  // we require client_secret. For public clients, client_secret is optional but
  // PKCE is mandatory (which we enforce regardless).
  if (client_secret && client_secret !== client.client_secret) {
    return tokenError(c, "invalid_client");
  }

  // Look up the authorization code
  const { data: codeRow } = await admin()
    .from("mcp_oauth_codes")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (!codeRow) {
    return tokenError(c, "invalid_grant", "Authorization code not found");
  }

  // Verify code matches the client and redirect_uri
  if (codeRow.client_id !== client_id) {
    return tokenError(c, "invalid_grant", "Code was issued to a different client");
  }
  if (codeRow.redirect_uri !== redirect_uri) {
    return tokenError(c, "invalid_grant", "redirect_uri mismatch");
  }

  // Code expiration
  if (new Date(codeRow.expires_at) < new Date()) {
    return tokenError(c, "invalid_grant", "Authorization code expired");
  }

  // Code single-use enforcement
  if (codeRow.used_at) {
    // Per RFC 6749 §4.1.2: revoke any tokens previously issued from this code.
    // For Phase 1C we just deny; full token revocation comes in Phase 3.
    return tokenError(c, "invalid_grant", "Authorization code already used");
  }

  // PKCE verification
  const pkceOk = await verifyPkce(
    code_verifier,
    codeRow.code_challenge,
    codeRow.code_challenge_method,
  );
  if (!pkceOk) {
    return tokenError(c, "invalid_grant", "PKCE verification failed");
  }

  // Mark code as used
  await admin()
    .from("mcp_oauth_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code);

  // Update last_used_at on client
  await admin()
    .from("mcp_oauth_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", client_id);

  // Issue access token
  const { token, expires_in } = await signAccessToken({
    user_id: codeRow.user_id,
    client_id: codeRow.client_id,
    scope: codeRow.scope ?? "mcp.read mcp.write",
  });

  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in,
    scope: codeRow.scope ?? "mcp.read mcp.write",
  }, 200, {
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
  });
}

function tokenError(c: Context, error: string, description?: string) {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return c.json(body, 400, { "Cache-Control": "no-store" });
}
```

## 1C-3.6 `oauth/middleware.ts`

```ts
import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessToken } from "./jwt.ts";

declare module "hono" {
  interface ContextVariableMap {
    auth: {
      user_id: string;
      client_id: string;
      scope: string;
    };
  }
}

/**
 * Hono middleware that enforces Bearer JWT on protected routes.
 * Returns 401 with WWW-Authenticate header per RFC 6750 if missing/invalid.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer realm="StageIn MCP", error="invalid_token"`,
    });
  }

  const token = authHeader.slice(7).trim();
  const claims = await verifyAccessToken(token);
  if (!claims) {
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer realm="StageIn MCP", error="invalid_token", error_description="Token is invalid or expired"`,
    });
  }

  c.set("auth", {
    user_id: claims.sub,
    client_id: claims.client_id,
    scope: claims.scope,
  });

  await next();
};
```

## 1C-3.7 `index.ts` modifications

Add imports:

```ts
import { tokenExchange } from "./oauth/token.ts";
import { requireAuth } from "./oauth/middleware.ts";
```

Add token route (after existing oauth routes):

```ts
app.post("/oauth/token", tokenExchange);
```

Apply middleware to MCP route. Replace existing:

```ts
app.all("/", async (c) => {
  const transport = new StreamableHTTPTransport();
  await mcp.connect(transport);
  return transport.handleRequest(c);
});
```

With:

```ts
app.all("/", requireAuth, async (c) => {
  const transport = new StreamableHTTPTransport();
  await mcp.connect(transport);
  return transport.handleRequest(c);
});
```

Note: this BREAKS the unauthenticated test we did in Phase 1B. That's expected — from now on MCP requests need a Bearer token.

## 1C-3.8 Test plan for PR 1C-3

Continuing from PR 1C-2 stage 2 (we have a `code` and `code_verifier` in hand):

```bash
ISSUER="https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp"
CLIENT_ID="<from previous step>"
CLIENT_SECRET="<from registration response>"
CODE="<from callback redirect>"
CODE_VERIFIER="<from PKCE generation>"
REDIRECT_URI="https://localhost:8443/cb"

# Test 1: Successful token exchange
echo "=== POST /oauth/token (valid) ==="
RESPONSE=$(curl -sS -X POST "$ISSUER/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=$REDIRECT_URI&code_verifier=$CODE_VERIFIER")
echo "$RESPONSE" | python3 -m json.tool

ACCESS_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Test 2: Try to reuse code (should fail)
echo "=== Code reuse rejected ==="
curl -sS -X POST "$ISSUER/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$CODE&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=$REDIRECT_URI&code_verifier=$CODE_VERIFIER" \
  -w "\nHTTP %{http_code}\n"

# Test 3: Authenticated MCP request
echo "=== MCP initialize with Bearer token ==="
curl -sS -X POST "$ISSUER" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# Test 4: MCP without token (should 401)
echo "=== MCP without token ==="
curl -sS -X POST "$ISSUER" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  -w "\nHTTP %{http_code}\n"

# Test 5: MCP with invalid token (should 401 with WWW-Authenticate)
echo "=== MCP with bad token ==="
curl -sS -i -X POST "$ISSUER" \
  -H "Authorization: Bearer not.a.valid.jwt" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -20
```

## 1C-3.9 Acceptance criteria for PR 1C-3

- [ ] `POST /oauth/token` with valid grant returns 200, JSON with `access_token`, `token_type: Bearer`, `expires_in: 3600`
- [ ] `Cache-Control: no-store` and `Pragma: no-cache` headers present on token response
- [ ] Code reuse returns 400 `invalid_grant` with description "Authorization code already used"
- [ ] Wrong PKCE verifier returns 400 `invalid_grant` "PKCE verification failed"
- [ ] Wrong client_secret returns 400 `invalid_client`
- [ ] Wrong redirect_uri returns 400 `invalid_grant` "redirect_uri mismatch"
- [ ] Expired code returns 400 `invalid_grant` "Authorization code expired"
- [ ] MCP `POST /` with valid Bearer returns 200 with `serverInfo`
- [ ] MCP `POST /` without Authorization header returns 401 with `WWW-Authenticate` header
- [ ] MCP `POST /` with malformed token returns 401
- [ ] DB: `mcp_oauth_codes.used_at` set after token exchange
- [ ] DB: `mcp_oauth_clients.last_used_at` updated after successful token exchange

---

# 5. End-to-end test scenarios (after all 3 PRs merged)

## E2E-1: Full OAuth dance + MCP call

```bash
ISSUER="https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp"

# 1. Discover
curl -sS "$ISSUER/.well-known/oauth-authorization-server" | jq

# 2. Register
REG=$(curl -sS -X POST "$ISSUER/oauth/register" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"E2E","redirect_uris":["https://localhost:8443/cb"]}')
CLIENT_ID=$(echo "$REG" | jq -r .client_id)
CLIENT_SECRET=$(echo "$REG" | jq -r .client_secret)

# 3. PKCE
CV=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)
CC=$(echo -n "$CV" | openssl dgst -sha256 -binary | base64 | tr "+/" "-_" | tr -d "=")

# 4. Open in browser, complete email flow:
echo "Open: $ISSUER/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https://localhost:8443/cb&code_challenge=$CC&code_challenge_method=S256&state=e2e-$RANDOM"
read -p "Paste code from final redirect: " CODE

# 5. Exchange
TOKEN=$(curl -sS -X POST "$ISSUER/oauth/token" \
  -d "grant_type=authorization_code&code=$CODE&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=https://localhost:8443/cb&code_verifier=$CV" \
  | jq -r .access_token)

# 6. Authenticated MCP
curl -sS -X POST "$ISSUER" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}'
```

## E2E-2: MCP Inspector integration

After the above works, point MCP Inspector at the server:

```bash
npx -y @modelcontextprotocol/inspector
# In UI: Transport = HTTP, URL = https://[ref].supabase.co/functions/v1/mcp
# Inspector will trigger DCR + auth flow automatically
# Open the magic link, complete flow, see "Connected" status
```

This is the closest simulation of how Claude.ai will behave.

## E2E-3: Real Claude.ai connector test

After E2E-2 passes, add the server to Claude.ai as a custom connector (Pro/Team plan required for testing):

1. Claude.ai → Settings → Integrations → Add custom connector
2. URL: `https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp`
3. Click Connect
4. Should redirect to authorize, send email, complete flow, return to Claude.ai with green "Connected"

This is the **production validation gate** — passing E2E-3 means we're ready for fazy 2 (tools).

---

# 6. Risks and known issues

## R1: Supabase magic-link redirect_to allowlist

Supabase Auth has an allowlist for `emailRedirectTo` URLs. By default it includes `https://[ref].supabase.co/*` which covers our case, but worth verifying in:

Dashboard → Authentication → URL Configuration → Redirect URLs

If callback fails with "redirect_to not allowed" error, add `${ISSUER}/oauth/callback` to the list.

## R2: Email deliverability

Supabase free tier has limited email sends. Magic links may get delayed or marked as spam. For testing use a Gmail/Outlook account (good deliverability), not a custom domain that hasn't built reputation.

For production: Phase 1D should configure custom SMTP (Resend, Postmark, or AWS SES) — but not blocker for 1C completion.

## R3: JWT secret rotation

`MCP_JWT_SECRET` is set manually in Supabase Dashboard → Settings → Edge Functions → Secrets. It is independent of Supabase Auth's own JWT secret — rotating Supabase Auth's secret does NOT affect our access tokens.

However, if `MCP_JWT_SECRET` itself is rotated (deleted and re-created), all our previously-issued access tokens become invalid simultaneously. There's no graceful migration window. Plan for this:

- Communicate to active clients before rotation
- Or implement dual-key verification (Phase 3 hardening): keep accepting old key for 1h after rotation while new key is primary for signing

Document the operational runbook for rotation: backup old value, generate new (32+ bytes random), update in Dashboard, deploy any code changes if key derivation logic changed, monitor 401 rate spike.

## R4: Browser cookies during callback

Some browsers (Safari ITP) may strip session cookies during the magic-link redirect. Symptoms: callback loads but `getUser()` returns null. If observed, switch from `signInWithOtp` to a token-based flow (Supabase generates a token, embeds it in the magic link URL, we verify the token directly without cookies).

## R5: Race condition on code consumption

If a client retries the token exchange (network timeout) before our `used_at` update commits, both requests could pass. Postgres `UPDATE ... WHERE used_at IS NULL RETURNING *` would solve this atomically. **TODO in Phase 3 hardening.**

## R6: No refresh tokens

We don't issue refresh tokens in Phase 1C. After 1h the client must redo the full flow (including email). This is acceptable for V1 because:
- Magic-link UX is friction users tolerate once per session
- Refresh token rotation is a separate complexity surface
- Phase 2 tools will use the access token within its 1h window

Refresh tokens are a Phase 1D candidate.

---

# 7. What this unlocks (post-1C readiness)

After all three PRs merged and E2E-3 passing:

## 7.1 Phase 2 — Tools

The MCP server has authentication. Now we can register tools that:

- Use `c.get("auth").user_id` to scope read tools to user's preferences
- Use `c.get("auth").user_id` to write to per-user tables (`price_alerts`, `artist_follows`, `newsletter_subscribers`)
- Reject scope-mismatched calls (e.g. `mcp.read` token trying to call `track_price`)

## 7.2 Submission readiness

Each directory has different requirements:

| Directory | Phase 1C unlocks |
|---|---|
| Smithery | Yes (instant publish) — `smithery mcp publish "$ISSUER" -n stagein/stagein` |
| Anthropic Connectors | Yes — submit via claude.com/docs/connectors/building/submission once Phase 2 tools added |
| OpenAI ChatGPT Apps | Partial — they require business identity + demo account; OAuth is a prereq, content review after |
| Glama | Auto (just needs public GitHub) |
| Official MCP Registry | Yes (PR to github.com/modelcontextprotocol/servers) |

## 7.3 Branding & polish (Phase 1D, optional)

- Custom domain `mcp.stagein.pl` (CNAME to Supabase)
- Custom email templates for magic link (StageIn brand)
- Custom SMTP provider (Resend or Postmark)
- Login form polished to full StageIn brand book aesthetic
- Privacy policy and Terms of Service pages live at stagein.pl

These can ship in any order after 1C.

---

# 8. Decision log (preemptive answers to questions Claude Code will ask)

**Q: Why HS256 instead of RS256?**
A: HS256 is simpler (single shared secret, no key management overhead) and is cryptographically equivalent for our threat model (we're both issuer and verifier — asymmetric crypto would only matter if we wanted external systems to verify our tokens without contacting us, which we don't). The HMAC secret is set as `MCP_JWT_SECRET` in Supabase Dashboard.

**Q: Why no refresh tokens in v1?**
A: See R6. Adds complexity (rotation, revocation, single-use enforcement, longer-lived storage). Not blocker for any submission directory. Magic-link UX is the actual UX cost, and we can add refresh tokens later without breaking changes.

**Q: Why client_secret_post and not client_secret_basic?**
A: MCP clients vary in their HTTP client capabilities. POST body is universally supported. Basic auth header is also fine but redundant once we accept POST.

**Q: Why store client_secret in plaintext?**
A: This is a TODO. For Phase 1C we accept plaintext (no client lookup is exposed externally, only service_role can read). Phase 3 hardening should hash with bcrypt or argon2id and update the verification path accordingly.

**Q: Why is the login form server-rendered HTML, not a SPA?**
A: Two reasons: (1) zero extra deployment surface, (2) progressive enhancement — works without JS. The form is 80 lines of HTML with embedded CSS, no build step needed.

**Q: Can a single user authorize multiple clients?**
A: Yes. Each `(user_id, client_id)` is an independent grant. No "user must approve once" caching in 1C — every authorize flow goes through email. Phase 1D could add "remember this device" with cookies + cookie-based session lookup.

**Q: What if Supabase Auth is disabled in the project?**
A: It's enabled (verified in pre-flight checklist). If it gets disabled, the entire authorize flow breaks. Detection: pre-flight tests catch it. Mitigation: Dashboard alert on Auth disable.

---

# 9. Implementation sequencing within each PR

For each PR, work in this order:

1. **DB migrations first** (1C-2 only — needs `mcp_oauth_authorize_state`)
   - Apply via Supabase MCP `apply_migration`
   - Verify tables and constraints
   - Commit migration SQL to `supabase/migrations/`

2. **Types and contracts** (`types.ts`, schema definitions)
   - Define before any handler code
   - Get Zod schemas right first

3. **Pure functions** (PKCE, JWT, state generation)
   - Easy to unit test
   - No I/O, deterministic

4. **Handlers** (`register.ts`, `authorize.ts`, etc.)
   - Each handler in isolation
   - Validation first, business logic second

5. **Mounting in `index.ts`**
   - Last step
   - Verify all routes are reachable

6. **Local sanity** (`deno check`, `deno lint`)

7. **Commit, push, PR**

8. **Wait for CI green**

9. **Merge** (Squash, linear history, delete branch)

10. **Post-deploy verification** (curl tests + Supabase MCP cross-check)

---

# 10. When in doubt

If implementation gets stuck on a subtle issue:

- **Cryptography questions:** Don't improvise. Ask before deviating from spec — RFC 6749, RFC 7591, RFC 7636, RFC 9728 are the canonical sources.
- **Supabase Auth quirks:** Look at the actual response shape, don't trust documentation. `console.log(JSON.stringify(...))` everything.
- **PKCE failures:** 90% of the time it's encoding (base64url vs base64) or whitespace. Verify byte-by-byte.
- **JWT verification failures:** Check the secret first. `MCP_JWT_SECRET` must be set in Supabase Dashboard → Settings → Edge Functions → Secrets. For local dev: add to `supabase/functions/.env` (gitignored). The env var name is the same in dev and prod.

---

**End of spec.**

This document is the source of truth for Phase 1C implementation. If reality diverges from this spec, update the spec — don't let drift accumulate silently.
