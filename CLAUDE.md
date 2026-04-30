# StageIn MCP Server

## Context

This is the **MCP (Model Context Protocol) server for StageIn** — a Polish concert and event ticket aggregator. The server exposes StageIn's database to AI assistants (Claude, ChatGPT, Cursor, etc.) so users can search, discover, and track tickets directly from chat.

- **Production target:** `https://mcp.stagein.pl`
- **Owner:** Przemysław Kołakowski (Harbor LEGAL / StageIn)
- **Phase:** 0 — initial setup
- **Source of truth for plan:** `STAGEIN_MCP_IMPLEMENTATION_PLAN.md`
- **Source of truth for tasks:** `TODO.md`

## Architecture

Stack:
- **Runtime:** Supabase Edge Function (Deno + TypeScript). NOT Cloudflare Workers, NOT Vercel.
- **Database:** Supabase Postgres (project `zrirjplulfqmjgtdwspt`) — accessed with `service_role` key.
- **Auth:** OAuth 2.1 bridge over Supabase Auth magic-link, with Dynamic Client Registration (RFC 7591).
- **Domain:** `mcp.stagein.pl` (CNAME to `[ref].functions.supabase.co`).
- **Transport:** Streamable HTTP (MCP standard).
- **Validation:** Zod, strict.

Repo structure:

```
supabase/
  functions/
    mcp/                  # MCP server entry point + tools
      index.ts
      tools/              # 9 tools (6 read + 3 write)
      lib/                # shared helpers (supabase, affiliate, auth, ratelimit, cache, errors, client_detection, format)
      oauth/              # OAuth bridge: register, authorize, callback, token
      types/              # generated DB types + custom types
  migrations/             # DB migrations (extensions, indexes, mcp tables)
docs/                     # TOOLS.md, AUTH.md, performance-baseline.md
scripts/                  # bench.ts, e2e.ts
README.md
PRIVACY.md
LICENSE                   # MIT
```

### Routing convention

Supabase Edge Runtime forwards the full request path INCLUDING function name. A request to `/functions/v1/mcp/health` arrives at the Deno handler as `/mcp/health`. The Hono app uses `.basePath("/mcp")` to strip this prefix, so all route definitions inside the app are written without the `/mcp` prefix (e.g. `app.get("/health", ...)`).

If you ever change the function name from `mcp` to something else, update the basePath accordingly.

## Key conventions

### Language
- Tool **descriptions** in English (improves AI tool selection).
- User-facing **data** (event titles, descriptions, artist bios) returned in Polish (native).
- **Error messages** in English.
- **Code comments** in English.

### Tool response shape
Every tool returns:
```ts
{
  content: [
    { type: "text", text: JSON.stringify(structuredData) }
  ]
}
```
Each event/listing in response includes:
- `permalink`: `https://stagein.pl/event/{slug}`
- `affiliate_url`: built via `lib/affiliate.ts` (see Affiliate URL section)

### Affiliate URL format
Use `lib/affiliate.ts` helper exclusively. Format:
```
https://stagein.pl/api/redirect
  ?eventId={uuid}
  &source={partner}            # from listings.source ∈ {alebilet, ticketmaster, ebilet, going, eventim, biletomat, empikbilety}
  &section=mcp:{client}        # from User-Agent detection
  &listingId={uuid}            # optional, only for find_cheapest_ticket and listings in get_event
```

### MCP traffic tagging via `section`
Detect client in `lib/client_detection.ts` from User-Agent or MCP `_meta.client_name`:
- `mcp:claude` — Claude Desktop, Claude.ai, Claude Code
- `mcp:chatgpt` — ChatGPT
- `mcp:cursor` — Cursor
- `mcp:smithery` — Smithery proxy
- `mcp:unknown` — fallback

This tagging uses the existing `affiliate_clicks.section` column (text, nullable). No DB schema change needed.

### Database access
- Always `service_role` key (`SUPABASE_SERVICE_ROLE_KEY` secret).
- RLS is bypassed by service_role — business rules enforced in code.
- Mandatory filters for events: `status='active' AND event_date >= CURRENT_DATE`.
- Mandatory filter for listings: `is_available=true`.
- Indexes are critical — see `supabase/migrations/*_indexes_for_mcp.sql`.

### Auth
- 6 read tools: **no auth**.
- 3 write tools: **OAuth required** (track_price, follow_artist, subscribe_newsletter).
- OAuth flow: 2.1 with PKCE + Dynamic Client Registration.
- Backend: Supabase Auth magic-link (no passwords).
- Access token = Supabase JWT with custom claim `mcp_scope`.

### Rate limiting
- 60 req/min per IP (anonymous).
- 600 req/h per authenticated user.
- Storage: `mcp_rate_limit` table with `INSERT ... ON CONFLICT (ip, window_start) DO UPDATE SET count = count + 1`.
- Cleanup: `pg_cron` job every hour.

### Error handling
- Custom error classes in `lib/errors.ts`.
- Map to MCP error codes: `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error.
- Empty results → friendly message, NOT error.
- Every tool logs entry + exit + duration as structured JSON via `console.log` (Supabase Logs auto-parse).

### Code style
- Deno strict mode (`"strict": true`).
- TypeScript strict, no `any`, no `// @ts-ignore`.
- Zod for ALL input validation.
- 2-space indent.
- Imports sorted: std → third-party → local.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`.
- Each tool in its own file under `supabase/functions/mcp/tools/`.
- Each tool exports `{ name, description, schema, handler, annotations }`.

## Key DB tables

Read-only (existing in production):
- `events` (~4583) — `id`, `title`, `slug`, `event_date`, `mood_tags`, `category`, `fts` (tsvector), `affiliate_url`, `image_url`, `ai_description`.
- `listings` (~7112) — offers from 7 sources, `source`, `price_min`, `price_max`, `is_available`, `sale_type`, `ticket_url`, `affiliate_url`.
- `venues` (~1049) — `name`, `city`, `latitude`, `longitude`.
- `artists` (~685) — `name`, `spotify_*`, `bio_pl`, `youtube_video_id`.
- `affiliate_clicks` — log table, write-only from `/api/redirect` endpoint.

Write (existing, used by write tools):
- `price_alerts` — track price tool target.
- `artist_follows` — follow artist tool target.
- `newsletter_subscribers` — subscribe newsletter tool target.

To be created in Phase 1 migrations:
- `mcp_rate_limit` — sliding-window rate limit counter.
- `mcp_oauth_clients` — DCR registered clients.
- `mcp_oauth_codes` — short-lived (10min) authorization codes.

## Important — DO NOT

- **Do NOT** add Cloudflare Workers, Vercel API routes, or any other runtime — Supabase Edge Function only.
- **Do NOT** construct affiliate URLs manually — always use `lib/affiliate.ts`.
- **Do NOT** use `any` type or `// @ts-ignore`.
- **Do NOT** include emojis anywhere in code, docs, or response content (StageIn brand rule).
- **Do NOT** modify `events.affiliate_url`, `listings.affiliate_url`, or any other production data — read only on existing tables.
- **Do NOT** commit `.env`, `.env.local`, or any secret files.
- **Do NOT** mark a task `[x]` in `TODO.md` without verifying with a manual or scripted test.
- **Do NOT** translate Polish event titles or descriptions in responses.
- **Do NOT** use Title Case in user-facing strings — sentence case only.
- **Do NOT** assume `pgvector` is enabled — it is in v3, NOT v1.
- **Do NOT** deploy MCP function without `--no-verify-jwt` flag — MCP clients manage their own auth, Supabase JWT layer would block them. The `deploy.yml` workflow uses this flag.

## Workflow

For every task:
1. Pick the next unchecked item from `TODO.md` (top-down within current phase).
2. Read the relevant section of `STAGEIN_MCP_IMPLEMENTATION_PLAN.md` for full context.
3. Implement. Use TypeScript strict + Zod + structured logging.
4. Test:
   - Local: `supabase functions serve mcp` + `npx @modelcontextprotocol/inspector`.
   - For DB changes: `supabase db reset` then verify with `EXPLAIN ANALYZE`.
5. Commit with conventional message referencing the phase: `feat(phase-1): add idx_events_fts migration`.
6. Mark item `[x]` in `TODO.md`.

If a task is unclear, blocked, or seems wrong — STOP and ask before guessing. Never silently change scope.

## Useful commands

```bash
# Local dev
supabase start
supabase functions serve mcp --env-file ./supabase/.env.local

# Test against local with MCP Inspector
npx @modelcontextprotocol/inspector http://localhost:54321/functions/v1/mcp

# Test against local with auth flow
npx @modelcontextprotocol/inspector --auth oauth http://localhost:54321/functions/v1/mcp

# Deploy function
supabase functions deploy mcp

# DB migrations
supabase migration new <name>
supabase db push                    # push to linked project
supabase db reset                   # reset local + replay migrations

# Generate TypeScript types from DB
supabase gen types typescript --linked > supabase/functions/mcp/types/database.ts

# Performance test
deno run --allow-net scripts/bench.ts

# E2E smoke test
deno run --allow-net --allow-env scripts/e2e.ts
```

## Reference docs

- Implementation plan: `STAGEIN_MCP_IMPLEMENTATION_PLAN.md`
- Task list: `TODO.md`
- MCP spec: https://modelcontextprotocol.io
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Anthropic submission: https://claude.com/docs/connectors/building/submission
- OpenAI Apps SDK: https://developers.openai.com/apps-sdk
- Smithery publish: https://smithery.ai/docs/concepts/cli
