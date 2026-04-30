# StageIn MCP — TODO

Source of truth for plan: `STAGEIN_MCP_IMPLEMENTATION_PLAN.md`

Workflow: pick top unchecked, read plan, implement, test, commit, mark `[x]`.

---

## Phase 0 — Pre-flight

- [x] `git init` in repo root, set `main` as default branch
- [x] Add `git remote add origin git@github.com:przemek-arch/stagein-mcp.git`
- [x] Create `.gitignore` (Deno + Supabase + macOS + IDE)
- [x] Create `LICENSE` (MIT, owner: Przemysław Kołakowski)
- [x] Create `README.md` skeleton (badges, description, quickstart placeholder, links)
- [x] Create `PRIVACY.md` skeleton (will be filled in Phase 5)
- [x] `supabase init` — initialize Supabase project structure
- [x] `supabase link --project-ref zrirjplulfqmjgtdwspt`
- [x] Create directory structure per `CLAUDE.md` § Architecture
- [x] Create empty placeholder files: `supabase/functions/mcp/index.ts`, `supabase/functions/mcp/lib/.gitkeep`, etc.
- [x] First commit: `chore: initial repo scaffold` (65b29d4)
- [x] Push to GitHub
- [ ] Setup branch protection on `main` (require PR, require typecheck CI) *(manual via GitHub UI)*
- [x] Create `.github/workflows/ci.yml` — typecheck + Deno lint on PR
- [x] Create `.github/workflows/deploy.yml` — `supabase functions deploy mcp` on merge to main
- [ ] DNS: configure CNAME `mcp.stagein.pl` → `[ref].functions.supabase.co` (in domain registrar + Supabase Dashboard → Custom Domains) *(deferred to Phase 1B)*
- [ ] Verify custom domain reachability with `curl https://mcp.stagein.pl/functions/v1/health` *(deferred to Phase 1B)*

## Phase 1A — DB migrations

- [x] `supabase migration new enable_extensions` — add `earthdistance`, `cube`, `pg_trgm`, `pg_cron`
- [x] `supabase migration new indexes_for_mcp` — 5 indexes (status_date/date/fts dropped as redundant vs existing prod indexes)
- [x] `supabase migration new mcp_rate_limit_table` — table + cleanup function + pg_cron schedule (column `window_start`, `window` is reserved keyword)
- [x] `supabase migration new mcp_oauth_tables` — `mcp_oauth_clients` + `mcp_oauth_codes`
- [x] Apply migrations to production *(via Supabase MCP `apply_migration` instead of `db push --linked` — see [docs/migrations.md](docs/migrations.md) for rationale)*
- [ ] Run `EXPLAIN ANALYZE` on each of 6 read query types — record in `docs/performance-baseline.md`
- [ ] Decide on `v_events_full` view based on perf measurements
- [ ] `supabase gen types typescript --linked > supabase/functions/mcp/types/database.ts`

## Phase 1B — Edge Function skeleton

- [ ] `supabase functions new mcp`
- [ ] `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<value>`
- [ ] Setup `import_map.json` with deps: MCP SDK, Zod, postgres client, std lib
- [ ] Implement `/health` route (returns `{status, version, uptime, db_reachable}`)
- [ ] Implement `/manifest` route (server name, description, contact, capabilities, auth metadata)
- [ ] Implement `/mcp` route with Streamable HTTP transport (empty tool list initially)
- [ ] Local test: `supabase functions serve mcp` + `npx @modelcontextprotocol/inspector http://localhost:54321/functions/v1/mcp`
- [ ] Verify `/health` and `/manifest` return correct shape
- [ ] Commit and deploy to production: `supabase functions deploy mcp`
- [ ] Verify production: `curl https://mcp.stagein.pl/functions/v1/mcp/health`

## Phase 1C — OAuth bridge

- [ ] `oauth/register.ts` — DCR (RFC 7591), INSERT into `mcp_oauth_clients`, return `client_id` + `client_secret`
- [ ] `oauth/authorize.ts` — PKCE check, generate code, INSERT into `mcp_oauth_codes`, redirect to magic-link
- [ ] `oauth/callback.ts` — handle Supabase Auth magic-link callback, attach session to code
- [ ] `oauth/token.ts` — exchange code → Supabase JWT (with `mcp_scope` custom claim)
- [ ] Helper `lib/auth.ts` — middleware checking Bearer token in `Authorization` header
- [ ] Set redirect URLs in Supabase Auth dashboard: `https://mcp.stagein.pl/oauth/callback`
- [ ] E2E auth flow test with `npx @modelcontextprotocol/inspector --auth oauth`
- [ ] Document auth flow in `docs/AUTH.md`

## Phase 2 — Read tools (shared infrastructure)

- [ ] `lib/supabase.ts` — singleton admin client (service_role)
- [ ] `lib/affiliate.ts` — `buildAffiliateUrl({eventId, source, section, listingId})`. NEVER manually construct URLs.
- [ ] `lib/format.ts` — date (Polish locale), price (PLN), distance (km)
- [ ] `lib/errors.ts` — custom error classes mapped to MCP error codes
- [ ] `lib/cache.ts` — wrapper for HTTP cache headers
- [ ] `lib/client_detection.ts` — detect `claude` / `chatgpt` / `cursor` / `smithery` / `unknown` from User-Agent or `_meta.client_name`
- [ ] `lib/ratelimit.ts` — sliding-window check via `mcp_rate_limit` table

## Phase 2 — Read tools (implementations)

For each tool: Zod schema, handler, formatter, unit tests (Deno test), integration test against staging DB.

- [ ] `tools/search_events.ts` — see plan § 4.1
- [ ] `tools/get_event.ts` — see plan § 4.2
- [ ] `tools/find_cheapest_ticket.ts` — see plan § 4.3
- [ ] `tools/search_by_artist.ts` — see plan § 4.4
- [ ] `tools/events_near.ts` — see plan § 4.5
- [ ] `tools/recommend_similar.ts` — see plan § 4.6
- [ ] Register all 6 tools in `mcp/index.ts` with annotations (`readOnlyHint=true`, `openWorldHint=true`, `idempotentHint=true`)
- [ ] Manual smoke test all 6 tools in MCP Inspector
- [ ] Add cache headers per tool (60s for search, 300s for get/by_artist/similar, none for events_near)
- [ ] Deploy and test against production

## Phase 3 — Write tools

- [ ] `tools/track_price.ts` — see plan § 4.7
- [ ] `tools/follow_artist.ts` — see plan § 4.8
- [ ] `tools/subscribe_newsletter.ts` — see plan § 4.9
- [ ] Confirmation email flow:
  - [ ] Edge function `send-confirmation` (separate from mcp; uses Resend or Supabase SMTP)
  - [ ] HTML template with StageIn brand (no emoji)
  - [ ] Magic-link confirmation URL with 24h TTL
- [ ] Auth middleware applied to write tools (returns 401 + auth hint URL when missing)
- [ ] Idempotency: second call with same params updates instead of creating duplicate
- [ ] E2E test: OAuth flow → write tool call → DB update → confirmation email received

## Phase 4 — Hardening

- [ ] Performance test: `scripts/bench.ts` runs 100 concurrent requests, reports p50/p95/p99
- [ ] Verify p95 targets: search < 300ms, get_event < 200ms, events_near < 400ms
- [ ] E2E smoke test: `scripts/e2e.ts` calls every tool with realistic inputs
- [ ] Manual test in 3 clients:
  - [ ] Claude Desktop (custom connector via URL)
  - [ ] Cursor (Settings → MCP)
  - [ ] ChatGPT developer mode (Settings → Connectors → custom)
- [ ] OAuth flow test in all 3 clients (each handles DCR slightly differently)
- [ ] Rate limit test: 100 requests in 1 minute should trigger 429 on 61st
- [ ] Error path tests for every tool (invalid input, missing event, etc.)

## Phase 5 — Branding & docs

- [ ] Logo SVG variants: 1024×1024, 512×512, 128×128 (StageIn brand + "MCP" badge)
- [ ] Favicon: 32×32, 64×64
- [ ] Capture 6-8 screenshots in Claude Desktop:
  1. search "rock concerts Warsaw December"
  2. get event details
  3. find cheapest ticket
  4. search by artist (Sanah / Daria Zawiałow)
  5. events near (Kraków lat/lng)
  6. recommend similar
  7. track price (with auth flow visible)
  8. follow artist (with auth flow visible)
- [ ] Write full `README.md`: description, tool list with examples, setup instructions for Claude/Cursor/ChatGPT, FAQ, links
- [ ] Write `docs/TOOLS.md` — full tool reference with schemas
- [ ] Write `docs/AUTH.md` — OAuth flow for developers
- [ ] Write `docs/PRIVACY.md` (or update `stagein.pl/privacy`)
- [ ] Add MCP section to `stagein.pl/llms.txt`
- [ ] Create `stagein.pl/mcp` landing page with setup instructions
- [ ] Create demo account `mcp-demo@stagein.pl` with password (NOT magic-link) for OpenAI review team
- [ ] Draft launch post for LinkedIn/Harbor LEGAL blog

## Phase 6 — Submission

### Smithery (instant, no review)
- [ ] `smithery auth login`
- [ ] `smithery mcp publish "https://mcp.stagein.pl" -n stagein/stagein`
- [ ] Verify listing on smithery.ai
- [ ] Add metadata: tags, category (`Travel & Events`), full description

### Official MCP Registry
- [ ] Fork `github.com/modelcontextprotocol/servers`
- [ ] Add entry under appropriate community category
- [ ] Open PR with name, URL, author, tags, description, README link

### Glama
- [ ] No action needed — auto-indexes public GitHub repo
- [ ] After 7 days, verify listing on glama.ai and submit corrections if needed

### Anthropic Connectors Directory
- [ ] Fill MCP directory submission form at claude.com/docs/connectors/building/submission
  - server basics, connection (auth=oauth, transport=streamable HTTP, capabilities=read+write)
  - allowed link URIs (7 partners + stagein.pl)
  - data & compliance, branding, docs link
- [ ] Wait for review (~1-2 weeks)

### OpenAI ChatGPT App Directory
- [ ] Identity verification (business) in OpenAI Developer Platform
- [ ] Test in Developer Mode in ChatGPT
- [ ] Submit with annotations + screenshots + identity proof + demo account credentials
- [ ] Wait for review (~2-4 weeks)

---

## Out of scope for v1 (future phases)

See plan § 11 Roadmapa post-launch:
- v2: Semantic search with `pgvector`
- v3: MCP Apps / Apps SDK widgets
- v4: Agentic Commerce / Stripe Connect
- v5: Multi-language tool descriptions
