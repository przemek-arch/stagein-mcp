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
