# StageIn MCP — Phase 2 — Tools Specification

**Status:** Ready for implementation
**Strategy:** B (sequential PRs), three sub-phases: 2A read tools, 2B write tools, 2C affiliate tracking + tool registration polish
**Prerequisites:** Phase 1A, 1B, 1C all merged and verified on production
**Estimated effort:** ~3-4 hours per sub-phase, focused work
**Author context:** Spec prepared by Claude Opus 4.7 after Phase 1C-3 Stage 1 completion (2026-05-04)

---

## 0. What this phase delivers

After Phase 1, we have:
- Edge Function with OAuth 2.1 surface
- Authenticated MCP transport (Bearer middleware)
- Empty tools list (`capabilities.tools.count: 0`)

Phase 2 fills that emptiness with **9 production tools** that turn the MCP server into a usable product:

| Tool | Type | Purpose |
|---|---|---|
| `search_events` | read | Free-text search with filters (city, date range, category, price) |
| `get_event` | read | Single event detail with all listings |
| `find_cheapest_ticket` | read | Cheapest available ticket for a given event across all sources |
| `search_by_artist` | read | Find all upcoming events for a given artist (fuzzy name match) |
| `events_near` | read | Geographic search by lat/lng + radius |
| `recommend_similar` | read | Similar events using artist genres + category + venue overlap |
| `track_price` | write | Subscribe to price drop alerts for an event |
| `follow_artist` | write | Subscribe to new event announcements for an artist |
| `subscribe_newsletter` | write | Sign up for StageIn weekly newsletter |

After Phase 2 merge, the MCP server is **submission-ready** for Smithery, official MCP Registry, and Glama. Anthropic Connectors and OpenAI ChatGPT Apps require Phase 1C-2 Stage 2 (real email E2E) plus Phase 1D polish (custom domain, branded login form, custom SMTP).

---

## 1. Production database state (verified 2026-05-04)

This is the actual state. Spec is written against it, not guesses.

### 1.1 Read tables

**`events`** — 4584 rows, **2893 active+upcoming**.

```
id              uuid            PK, gen_random_uuid()
title           text            NOT NULL
subtitle        text            nullable
description     text            nullable
venue_id        uuid            FK → venues.id
event_date      date            NOT NULL  ← MUST filter >= CURRENT_DATE
event_time      time            nullable
price_min       numeric         nullable
price_max       numeric         nullable
category        text            nullable, 9 distinct: MUZYKA(1703), SCENA(560), FESTIWAL(273), INNE(143), WYSTAWA(90), SPORT(55), STAND-UP(52), KONCERT(17)
subcategory     text            nullable, 53 distinct
mood_tags       text[]          DEFAULT '{}', ⚠ EMPTY in production (0 rows populated)
image_url       text            nullable
affiliate_url   text            nullable, AleBilet redirect URL when present
sold_percent    int             DEFAULT 0
is_hot          boolean         DEFAULT false
source          text            nullable
source_id       text            nullable
status          text            DEFAULT 'active'  ← MUST filter = 'active'
created_at      timestamptz     DEFAULT now()
updated_at      timestamptz     DEFAULT now()
artist_id       uuid            FK → artists.id (nullable; 1758/2893 active have it)
ticket_url      text            nullable
lineup          text[]          DEFAULT '{}'
tm_event_id     text            nullable, Ticketmaster ID
slug            text            nullable, ALL events have slug (4584/4584)
alebilet_event_id text          nullable, AleBilet ID
alebilet_slug   text            nullable, used for /api/redirect URL
ai_description  text            nullable, generated description
fts             tsvector        nullable, full-text search index
```

**Mandatory filters for ALL read tools:** `WHERE status = 'active' AND event_date >= CURRENT_DATE`. Encode this in a shared helper, not in every tool.

**`listings`** — 7187 rows, **4944 with available + upcoming + has price**.

```
id              uuid            PK
event_id        uuid            FK → events.id (nullable but always present in practice)
source          text            NOT NULL, 4 distinct sources (alebilet primary)
source_event_id text            nullable
price_min       numeric         nullable
price_max       numeric         nullable
offers_count    int             DEFAULT 0
ticket_url      text            nullable, raw vendor URL
affiliate_url   text            nullable, /api/redirect URL
category        text            nullable, ticket tier (regular/VIP/etc.)
subcategory     text            nullable
fetched_at      timestamptz     DEFAULT now()
created_at      timestamptz     DEFAULT now()
sale_type       text            DEFAULT 'primary' (5623 primary, 1564 secondary in active)
is_available    boolean         DEFAULT true  ← MUST filter = true
currency        text            DEFAULT 'PLN' (only PLN in production)
```

**`venues`** — 1051 rows, **141 with lat+lng** (only ~13% geocoded; events_near limited accordingly).

```
id              uuid            PK
name            text            NOT NULL
city            text            NOT NULL, 278 distinct cities
address         text            nullable
venue_type      text            nullable, 6 distinct (klub/teatr/stadion/etc.)
image_url       text            nullable
created_at      timestamptz     DEFAULT now()
latitude        double          nullable
longitude       double          nullable
country         text            DEFAULT 'Poland'
region          text            nullable, 16 distinct (województwa)
```

**`artists`** — 685 rows.

```
id                  uuid        PK
name                text        NOT NULL
spotify_id          text        nullable
spotify_image_url   text        nullable
spotify_genres      text[]      DEFAULT '{}', primary similarity signal (since mood_tags empty)
spotify_popularity  int         DEFAULT 0, 0-100 Spotify score
created_at          timestamptz DEFAULT now()
updated_at          timestamptz DEFAULT now()
youtube_video_id    text        nullable
bio_pl              text        nullable, Polish bio
spotify_top_tracks  jsonb       DEFAULT '[]'
spotify_followers   int         DEFAULT 0
```

### 1.2 Write tables

**`price_alerts`** — 0 rows currently.

```
id                  uuid        PK, gen_random_uuid()
email               text        NOT NULL  ← we'll populate from auth.users.email via JWT.sub
event_id            uuid        NOT NULL, FK → events.id
price_at_alert      numeric     NOT NULL  ← snapshot price at subscription time
source              text        NOT NULL  ← which listing source the alert is anchored to
created_at          timestamptz DEFAULT now()
is_active           boolean     DEFAULT true
last_notified_at    timestamptz nullable
```

**`artist_follows`** — 0 rows currently.

```
id          uuid        PK
email       text        NOT NULL  ← from auth.users
artist_id   uuid        NOT NULL, FK → artists.id
created_at  timestamptz DEFAULT now()
is_active   boolean     DEFAULT true
```

**`newsletter_subscribers`** — 0 rows currently.

```
id                   uuid        PK
email                text        NOT NULL
city                 text        nullable
preferences          text[]      DEFAULT '{}'
is_active            boolean     DEFAULT true
confirmed            boolean     DEFAULT false  ← double opt-in flow
confirmation_token   text        nullable
created_at           timestamptz DEFAULT now()
```

### 1.3 Indexes available (created in Phase 1A)

```
idx_events_active_date          (status, event_date)
idx_events_artist               (artist_id) WHERE artist_id IS NOT NULL
idx_events_mood_tags            GIN(mood_tags) — currently unused due to empty mood_tags
idx_events_fts                  GIN(fts)
idx_listings_event_avail        (event_id, is_available, price_min) WHERE is_available = true
idx_venues_geo                  GIST(ll_to_earth(lat, lng))
idx_artists_name_trgm           GIN(name gin_trgm_ops)
```

These dictate query patterns. Don't write a query that ignores its index.

---

## 2. Cross-cutting design decisions

These apply to every tool. Locking them in here prevents drift.

### 2.1 User identity from JWT

Bearer middleware (Phase 1C-3) sets `c.get("auth")` with `{user_id, client_id, scope}`. Write tools use `auth.user_id` to look up email from `auth.users`. We never trust an email passed in tool params for write operations.

```ts
// Helper, save in lib/user.ts:
export async function getUserEmail(user_id: string): Promise<string | null> {
  const { data, error } = await admin().auth.admin.getUserById(user_id);
  if (error || !data?.user?.email) return null;
  return data.user.email;
}
```

### 2.2 Mandatory query filters

Every event lookup MUST include `status = 'active' AND event_date >= CURRENT_DATE`. Codify in helper:

```ts
// lib/queries.ts
export const ACTIVE_UPCOMING_FILTER = (qb: any) =>
  qb.eq("status", "active").gte("event_date", new Date().toISOString().slice(0, 10));
```

Every listing lookup MUST include `is_available = true`. Same pattern.

### 2.3 Permalink + affiliate URL construction

Every tool response includes a `permalink` (StageIn page) and `affiliate_url` (clickable purchase link with our affiliate tag).

```ts
// lib/affiliate.ts
const BASE = "https://stagein.pl";

export function permalink(slug: string): string {
  return `${BASE}/event/${slug}`;
}

export function affiliateUrl(params: {
  eventId: string;
  source: string;       // 'alebilet' | 'ticketmaster' | etc.
  section: string;      // 'mcp:claude' | 'mcp:chatgpt' | 'mcp:cursor'
  listingId?: string;
}): string {
  const sp = new URLSearchParams({
    eventId: params.eventId,
    source: params.source,
    section: params.section,
  });
  if (params.listingId) sp.set("listingId", params.listingId);
  return `${BASE}/api/redirect?${sp.toString()}`;
}
```

`section` is derived from the OAuth client's `client_name` at call time — see §6 affiliate tracking.

### 2.4 Tool response shape

Every read tool returns a uniform shape:

```ts
{
  results: Array<{...tool-specific fields, plus permalink, affiliate_url}>,
  total: number,                    // total matching, not just returned
  query_time_ms: number,            // server-side query latency
}
```

Every write tool returns:

```ts
{
  ok: boolean,
  message: string,                  // human-readable confirmation in EN
  resource_id?: string,             // UUID of created row
}
```

Errors throw, MCP SDK serializes them. Don't return error objects from tools.

### 2.5 Tool input validation

Every tool uses Zod for input schema. MCP SDK's `tool()` API takes Zod schema directly. Schema definition IS the JSON-schema exposed to clients.

### 2.6 Performance targets (per CLAUDE.md)

```
search_events       p95 < 300ms
get_event           p95 < 200ms
find_cheapest_ticket p95 < 200ms
search_by_artist    p95 < 300ms
events_near         p95 < 400ms
recommend_similar   p95 < 500ms
write tools         p95 < 200ms
```

After deploy, we measure via Supabase Logs `execution_time_ms`. Spec assumes these are achievable with current indexes; if reality differs, Phase 3 adds targeted indexes.

### 2.7 Languages

- Tool descriptions and parameter docs: **English** (consumed by AI clients globally).
- User-facing data (event titles, venue names, descriptions): **Polish** (DB content).
- Error messages thrown to client: **English**.
- Newsletter and notification emails (Phase 2 write tools): triggered from this server but rendered Polish (handled by other StageIn infrastructure, not our concern here).

### 2.8 Rate limiting

Out of scope for Phase 2. Phase 3 hardening uses `mcp_rate_limit` table. Bearer JWT contains `client_id` + `sub` — both available for keying.

### 2.9 Empty mood_tags reality

Spec originally promised `recommend_similar` using mood_tags overlap. Production has 0 events with mood_tags populated. We pivot to:

1. **Spotify genre overlap** (artists.spotify_genres) — primary signal
2. **Same artist** — deterministic match
3. **Same category + same city** — fallback
4. **Same venue** — fallback fallback

When mood_tags get populated in the future, we add it as a fifth signal.

---

## 3. PR sequencing

**Strategy B** carries over from Phase 1: small PRs, isolated failure surface.

| PR | Title | Tools | Risk |
|---|---|---|---|
| **2A-1** | Tool registration scaffold + 1 simple tool | `search_events` | Low — proves wiring |
| **2A-2** | Detail tools | `get_event`, `find_cheapest_ticket` | Low |
| **2A-3** | Artist + geo tools | `search_by_artist`, `events_near` | Medium (geo math + trigram) |
| **2A-4** | Recommendation tool | `recommend_similar` | Medium (multi-signal scoring) |
| **2B-1** | Write tools | `track_price`, `follow_artist`, `subscribe_newsletter` | Low |
| **2C-1** | Affiliate URL section tagging via JWT client_id | None new | Low |

Six PRs total. Phase 1C had 4. The increase is justified — write tools introduce DB writes which need their own review pass.

---

# PHASE 2A-1: Tool Registration Scaffold + `search_events`

## 2A-1.1 Goal

Establish the tool registration pattern. After this PR:
- MCP `initialize` returns non-empty `capabilities.tools`
- MCP `tools/list` returns `[search_events]`
- MCP `tools/call` with `search_events` returns real data

## 2A-1.2 New files

```
supabase/functions/mcp/
├── lib/
│   ├── user.ts              # NEW — getUserEmail helper
│   ├── queries.ts           # NEW — shared query helpers
│   └── affiliate.ts         # NEW — permalink + affiliate URL
├── tools/
│   ├── index.ts             # NEW — registers all tools on MCP server
│   └── search_events.ts     # NEW — first tool implementation
└── index.ts                 # MODIFY — call registerTools(mcp) before connect
```

## 2A-1.3 `lib/affiliate.ts`

```ts
const BASE = "https://stagein.pl";

export function permalink(slug: string | null): string | null {
  if (!slug) return null;
  return `${BASE}/event/${slug}`;
}

export function affiliateUrl(params: {
  eventId: string;
  source: string;
  section: string;
  listingId?: string;
}): string {
  const sp = new URLSearchParams({
    eventId: params.eventId,
    source: params.source,
    section: params.section,
  });
  if (params.listingId) sp.set("listingId", params.listingId);
  return `${BASE}/api/redirect?${sp.toString()}`;
}

/**
 * Derives 'section' attribution string from MCP client name.
 * Used to tag affiliate clicks by client (Claude/ChatGPT/Cursor/etc.).
 * The OAuth client_name set during DCR flows through to JWT.
 */
export function clientSection(clientName: string | undefined): string {
  if (!clientName) return "mcp:unknown";
  const lower = clientName.toLowerCase();
  if (lower.includes("claude")) return "mcp:claude";
  if (lower.includes("chatgpt") || lower.includes("openai")) return "mcp:chatgpt";
  if (lower.includes("cursor")) return "mcp:cursor";
  if (lower.includes("inspector")) return "mcp:inspector";
  return `mcp:${lower.replace(/[^a-z0-9]+/g, "_").slice(0, 20)}`;
}
```

> Note: `section` derivation is **simplified** in 2A-1. Phase 2C adds proper `client_id → section` lookup via DB. For now, the JWT doesn't even carry `client_name`, only `client_id`. Use `mcp:unknown` placeholder until 2C.

## 2A-1.4 `lib/queries.ts`

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Apply standard event filters: status='active' AND event_date >= today.
 * Returns the modified query builder for chaining.
 */
export function activeUpcomingEvents(qb: any) {
  const today = new Date().toISOString().slice(0, 10);
  return qb.eq("status", "active").gte("event_date", today);
}

/**
 * Apply standard listing filter: is_available = true.
 */
export function availableListings(qb: any) {
  return qb.eq("is_available", true);
}
```

## 2A-1.5 `lib/user.ts`

```ts
import { admin } from "./supabase.ts";

export async function getUserEmail(user_id: string): Promise<string | null> {
  try {
    const { data, error } = await admin().auth.admin.getUserById(user_id);
    if (error || !data?.user?.email) return null;
    return data.user.email;
  } catch {
    return null;
  }
}
```

## 2A-1.6 `tools/search_events.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { activeUpcomingEvents } from "../lib/queries.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  query: z.string().optional().describe("Free-text search across event title, subtitle, lineup, venue name"),
  city: z.string().optional().describe("Filter by city name (Polish, exact match — e.g., 'Warszawa', 'Kraków')"),
  category: z.enum([
    "MUZYKA", "SCENA", "FESTIWAL", "INNE", "WYSTAWA", "SPORT", "STAND-UP", "KONCERT"
  ]).optional().describe("Event category filter"),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date YYYY-MM-DD, inclusive"),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date YYYY-MM-DD, inclusive"),
  price_max: z.number().positive().optional().describe("Maximum minimum-price (PLN) — events with cheaper tickets only"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max results to return (1-50, default 10)"),
});

type Input = z.infer<typeof InputSchema>;

export function registerSearchEvents(mcp: McpServer) {
  mcp.tool(
    "search_events",
    "Search StageIn for upcoming concerts, festivals, and events. Returns events filtered by free-text query, city, category, date range, and price ceiling. Results include direct purchase links via StageIn affiliate redirects.",
    InputSchema.shape,
    async (input: Input, extra) => {
      const start = Date.now();
      const sectionTag = clientSection(undefined); // Phase 2C will fill this

      let qb = admin().from("events").select(`
        id, title, subtitle, event_date, event_time, price_min, price_max, 
        category, subcategory, slug, image_url, sold_percent, is_hot,
        venue:venue_id (id, name, city, region),
        artist:artist_id (id, name, spotify_image_url)
      `);

      qb = activeUpcomingEvents(qb);

      if (input.query) {
        // Use FTS for word-level matching, fallback to ilike for short queries
        if (input.query.length >= 3) {
          qb = qb.textSearch("fts", input.query.split(/\s+/).join(" & "));
        } else {
          qb = qb.ilike("title", `%${input.query}%`);
        }
      }
      if (input.city) {
        qb = qb.eq("venue.city", input.city);
      }
      if (input.category) {
        qb = qb.eq("category", input.category);
      }
      if (input.date_from) qb = qb.gte("event_date", input.date_from);
      if (input.date_to) qb = qb.lte("event_date", input.date_to);
      if (input.price_max !== undefined) qb = qb.lte("price_min", input.price_max);

      qb = qb.order("event_date", { ascending: true }).limit(input.limit);

      const { data, error, count } = await qb;
      if (error) throw new Error(`Database error: ${error.message}`);

      const results = (data ?? []).map((e: any) => ({
        id: e.id,
        title: e.title,
        subtitle: e.subtitle,
        date: e.event_date,
        time: e.event_time,
        category: e.category,
        subcategory: e.subcategory,
        price_min: e.price_min,
        price_max: e.price_max,
        currency: "PLN",
        is_hot: e.is_hot,
        sold_percent: e.sold_percent,
        venue: e.venue ? {
          name: e.venue.name,
          city: e.venue.city,
          region: e.venue.region,
        } : null,
        artist: e.artist ? {
          id: e.artist.id,
          name: e.artist.name,
          image_url: e.artist.spotify_image_url,
        } : null,
        image_url: e.image_url,
        permalink: permalink(e.slug),
        affiliate_url: affiliateUrl({
          eventId: e.id,
          source: "alebilet",
          section: sectionTag,
        }),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results,
            total: results.length,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
```

> **Note on MCP SDK API:** As of `@modelcontextprotocol/sdk@1.29`, `mcp.tool()` signature is `(name, description, paramsSchema, handler)`. Handler returns `{ content: [{ type, text }] }`. If 1C-3 verified earlier handler signature works, follow that.

## 2A-1.7 `tools/index.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchEvents } from "./search_events.ts";

export function registerTools(mcp: McpServer) {
  registerSearchEvents(mcp);
  // Phase 2A-2 adds: registerGetEvent, registerFindCheapestTicket
  // Phase 2A-3 adds: registerSearchByArtist, registerEventsNear
  // Phase 2A-4 adds: registerRecommendSimilar
  // Phase 2B-1 adds: registerTrackPrice, registerFollowArtist, registerSubscribeNewsletter
}
```

## 2A-1.8 `index.ts` modification

Add import:
```ts
import { registerTools } from "./tools/index.ts";
```

Right after `const mcp = new McpServer({...})`, add:
```ts
registerTools(mcp);
```

Also update `/manifest` route to reflect non-empty tools:
```ts
capabilities: {
  tools: { count: 1, status: "phase-2a-1" },
  auth: { type: "oauth-2.1", oauth_endpoints: { authorization_endpoint: ..., token_endpoint: ... } },
}
```

(Update count and status as we go through 2A-2 to 2A-4.)

## 2A-1.9 Test plan

After deploy:

```bash
ISSUER="https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp"

# We need a valid Bearer token. Use Stage 1 helper: register, inject mock code, exchange for JWT.
# Simplified — assume we have $TOKEN from the same flow we used in Phase 1C-3 Stage 1.

# Test 1: Verify tools/list now contains search_events
curl -sS -X POST "$ISSUER" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Expect: SSE message with tools array containing search_events with full schema

# Test 2: Call search_events with simple query
curl -sS -X POST "$ISSUER" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_events","arguments":{"query":"jazz","limit":5}}}'
# Expect: Real event data, results array, total, query_time_ms

# Test 3: Filter by city
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_events","arguments":{"city":"Warszawa","category":"MUZYKA","limit":3}}}'

# Test 4: Date range filter
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_events","arguments":{"date_from":"2026-06-01","date_to":"2026-06-30","limit":5}}}'

# Test 5: Invalid category (should fail with Zod error)
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_events","arguments":{"category":"INVALID_CAT"}}}'
```

## 2A-1.10 Acceptance criteria

- [ ] `tools/list` returns array with one entry: `search_events`
- [ ] Each tool has `description`, `inputSchema` matching Zod
- [ ] `tools/call search_events` returns valid JSON with `results`, `total`, `query_time_ms`
- [ ] Each result has `permalink`, `affiliate_url`, `venue` and `artist` nested objects
- [ ] Filter by `city` works
- [ ] Filter by `category` works
- [ ] `date_from` + `date_to` work
- [ ] `price_max` works
- [ ] Invalid `category` enum returns MCP error (validation rejection)
- [ ] All returned events have `event_date >= today`
- [ ] All returned events have `status = active`
- [ ] `query_time_ms` < 500 (warm) on production data
- [ ] No regression on `/health`, `/manifest`, OAuth endpoints

---

# PHASE 2A-2: Detail Tools (`get_event`, `find_cheapest_ticket`)

## 2A-2.1 Goal

Complete the read-once-per-event flow: client sees a list (search_events), then drills into one event. Two tools, both single-event detail.

## 2A-2.2 New files

```
supabase/functions/mcp/tools/
├── get_event.ts                 # NEW
└── find_cheapest_ticket.ts      # NEW
```

## 2A-2.3 `tools/get_event.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { availableListings } from "../lib/queries.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Event UUID"),
});

export function registerGetEvent(mcp: McpServer) {
  mcp.tool(
    "get_event",
    "Get full details for a single StageIn event including all available ticket listings across sources, venue location, and artist info if applicable.",
    InputSchema.shape,
    async (input, extra) => {
      const start = Date.now();
      const section = clientSection(undefined);

      // Fetch event with venue and artist
      const { data: event, error: evtErr } = await admin()
        .from("events")
        .select(`
          id, title, subtitle, description, ai_description, event_date, event_time,
          price_min, price_max, category, subcategory, mood_tags, image_url,
          slug, sold_percent, is_hot, lineup, status,
          venue:venue_id (id, name, city, region, address, latitude, longitude, venue_type),
          artist:artist_id (id, name, spotify_genres, spotify_image_url, spotify_followers, spotify_popularity, bio_pl, youtube_video_id)
        `)
        .eq("id", input.event_id)
        .maybeSingle();

      if (evtErr) throw new Error(`Database error: ${evtErr.message}`);
      if (!event) throw new Error(`Event not found: ${input.event_id}`);
      if (event.status !== "active") throw new Error(`Event not active: ${input.event_id}`);

      // Fetch all available listings, sorted by price ascending
      let listingsQb = admin()
        .from("listings")
        .select("id, source, price_min, price_max, offers_count, category, subcategory, sale_type, currency, ticket_url, fetched_at")
        .eq("event_id", input.event_id);
      listingsQb = availableListings(listingsQb);
      listingsQb = listingsQb.order("price_min", { ascending: true, nullsFirst: false });

      const { data: listings, error: lstErr } = await listingsQb;
      if (lstErr) throw new Error(`Database error: ${lstErr.message}`);

      const result = {
        id: event.id,
        title: event.title,
        subtitle: event.subtitle,
        description: event.description ?? event.ai_description,
        date: event.event_date,
        time: event.event_time,
        category: event.category,
        subcategory: event.subcategory,
        price_min: event.price_min,
        price_max: event.price_max,
        currency: "PLN",
        is_hot: event.is_hot,
        sold_percent: event.sold_percent,
        lineup: event.lineup,
        image_url: event.image_url,
        venue: event.venue,
        artist: event.artist,
        permalink: permalink(event.slug),
        affiliate_url: affiliateUrl({
          eventId: event.id,
          source: "alebilet",
          section,
        }),
        listings: (listings ?? []).map((l: any) => ({
          id: l.id,
          source: l.source,
          sale_type: l.sale_type,
          category: l.category,
          subcategory: l.subcategory,
          price_min: l.price_min,
          price_max: l.price_max,
          currency: l.currency,
          offers_count: l.offers_count,
          fetched_at: l.fetched_at,
          affiliate_url: affiliateUrl({
            eventId: event.id,
            source: l.source,
            section,
            listingId: l.id,
          }),
        })),
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            event: result,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
```

## 2A-2.4 `tools/find_cheapest_ticket.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { availableListings } from "../lib/queries.ts";
import { affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Event UUID"),
  sale_type: z.enum(["primary", "secondary", "any"]).default("any")
    .describe("Filter by primary (official) or secondary (resale) market. 'any' returns cheapest across both."),
});

export function registerFindCheapestTicket(mcp: McpServer) {
  mcp.tool(
    "find_cheapest_ticket",
    "Find the cheapest currently-available ticket for a given event across all StageIn ticket sources. Returns single best offer with direct purchase link, source vendor name, and price tier.",
    InputSchema.shape,
    async (input, extra) => {
      const start = Date.now();
      const section = clientSection(undefined);

      let qb = admin()
        .from("listings")
        .select("id, event_id, source, price_min, price_max, sale_type, category, subcategory, currency, offers_count")
        .eq("event_id", input.event_id);
      qb = availableListings(qb);

      if (input.sale_type !== "any") {
        qb = qb.eq("sale_type", input.sale_type);
      }
      qb = qb.not("price_min", "is", null)
              .order("price_min", { ascending: true })
              .limit(1);

      const { data, error } = await qb;
      if (error) throw new Error(`Database error: ${error.message}`);

      if (!data || data.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              found: false,
              message: "No available tickets for this event matching the criteria.",
              query_time_ms: Date.now() - start,
            }),
          }],
        };
      }

      const cheapest = data[0];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            found: true,
            listing: {
              id: cheapest.id,
              source: cheapest.source,
              sale_type: cheapest.sale_type,
              category: cheapest.category,
              subcategory: cheapest.subcategory,
              price: cheapest.price_min,
              currency: cheapest.currency ?? "PLN",
              offers_count: cheapest.offers_count,
              affiliate_url: affiliateUrl({
                eventId: cheapest.event_id,
                source: cheapest.source,
                section,
                listingId: cheapest.id,
              }),
            },
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
```

## 2A-2.5 `tools/index.ts` update

```ts
import { registerSearchEvents } from "./search_events.ts";
import { registerGetEvent } from "./get_event.ts";
import { registerFindCheapestTicket } from "./find_cheapest_ticket.ts";

export function registerTools(mcp: McpServer) {
  registerSearchEvents(mcp);
  registerGetEvent(mcp);
  registerFindCheapestTicket(mcp);
}
```

## 2A-2.6 Test plan

```bash
# Use any event_id from search_events results in 2A-1
EVENT_ID="..."

# Test 1: get_event
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_event\",\"arguments\":{\"event_id\":\"$EVENT_ID\"}}}"

# Test 2: find_cheapest_ticket any
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"find_cheapest_ticket\",\"arguments\":{\"event_id\":\"$EVENT_ID\"}}}"

# Test 3: find_cheapest_ticket primary only
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"find_cheapest_ticket\",\"arguments\":{\"event_id\":\"$EVENT_ID\",\"sale_type\":\"primary\"}}}"

# Test 4: get_event with non-existent UUID
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_event","arguments":{"event_id":"00000000-0000-0000-0000-000000000000"}}}'
# Expect: error "Event not found"

# Test 5: get_event with malformed UUID
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_event","arguments":{"event_id":"not-a-uuid"}}}'
# Expect: Zod validation error
```

## 2A-2.7 Acceptance criteria

- [ ] `tools/list` returns 3 tools: search_events, get_event, find_cheapest_ticket
- [ ] `get_event` returns full event detail with listings sorted by price ascending
- [ ] `get_event` includes nested `venue` and `artist` objects
- [ ] `get_event` returns error for non-existent event_id
- [ ] `get_event` returns error for inactive (status != 'active') events
- [ ] `find_cheapest_ticket` returns single cheapest listing
- [ ] `find_cheapest_ticket` `sale_type` filter works
- [ ] `find_cheapest_ticket` returns `found: false` gracefully when no listings
- [ ] All `affiliate_url` values include event_id, source, section, listingId where applicable
- [ ] All `permalink` values are well-formed `https://stagein.pl/event/<slug>`
- [ ] No regression on Phase 2A-1 tools

---

# PHASE 2A-3: Artist + Geo Tools (`search_by_artist`, `events_near`)

## 2A-3.1 Goal

Two specialized search modes:
- Artist name → events (with fuzzy matching for typos)
- Lat/lng + radius → events at nearby venues

## 2A-3.2 New files

```
supabase/functions/mcp/tools/
├── search_by_artist.ts      # NEW
└── events_near.ts           # NEW
```

## 2A-3.3 `tools/search_by_artist.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { activeUpcomingEvents } from "../lib/queries.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  artist_name: z.string().min(2).max(100).describe("Artist name (fuzzy match supported via trigram similarity)"),
  limit: z.number().int().min(1).max(20).default(10).describe("Max events to return per matching artist"),
});

export function registerSearchByArtist(mcp: McpServer) {
  mcp.tool(
    "search_by_artist",
    "Find upcoming StageIn events for a given artist. Uses trigram fuzzy matching so typos and partial names work. Returns events for ALL matching artists (e.g., 'Behemoth' might match 'Behemoth' the band exactly while 'queen' could match 'Queen' and 'Queens of the Stone Age').",
    InputSchema.shape,
    async (input, extra) => {
      const start = Date.now();
      const section = clientSection(undefined);

      // Find matching artists via trigram similarity (idx_artists_name_trgm)
      const { data: artists, error: artErr } = await admin()
        .from("artists")
        .select("id, name, spotify_image_url, spotify_followers")
        .ilike("name", `%${input.artist_name}%`)
        .order("spotify_followers", { ascending: false, nullsFirst: false })
        .limit(5);

      if (artErr) throw new Error(`Database error: ${artErr.message}`);
      if (!artists || artists.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              matches: [],
              total: 0,
              message: `No artists found matching "${input.artist_name}".`,
              query_time_ms: Date.now() - start,
            }),
          }],
        };
      }

      // For each matching artist, fetch their upcoming events
      const matches = await Promise.all(artists.map(async (artist: any) => {
        let qb = admin().from("events").select(`
          id, title, subtitle, event_date, event_time, price_min, price_max,
          category, slug, image_url, is_hot,
          venue:venue_id (id, name, city, region)
        `).eq("artist_id", artist.id);
        qb = activeUpcomingEvents(qb);
        qb = qb.order("event_date", { ascending: true }).limit(input.limit);

        const { data: events } = await qb;

        return {
          artist: {
            id: artist.id,
            name: artist.name,
            image_url: artist.spotify_image_url,
            followers: artist.spotify_followers,
          },
          events: (events ?? []).map((e: any) => ({
            id: e.id,
            title: e.title,
            date: e.event_date,
            venue: e.venue,
            price_min: e.price_min,
            currency: "PLN",
            is_hot: e.is_hot,
            permalink: permalink(e.slug),
            affiliate_url: affiliateUrl({
              eventId: e.id, source: "alebilet", section,
            }),
          })),
        };
      }));

      const totalEvents = matches.reduce((sum, m) => sum + m.events.length, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            matches,
            total_artists: matches.length,
            total_events: totalEvents,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
```

## 2A-3.4 `tools/events_near.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  latitude: z.number().min(-90).max(90).describe("Search center latitude in decimal degrees"),
  longitude: z.number().min(-180).max(180).describe("Search center longitude in decimal degrees"),
  radius_km: z.number().positive().max(500).default(25).describe("Search radius in kilometers (max 500)"),
  limit: z.number().int().min(1).max(50).default(20),
});

export function registerEventsNear(mcp: McpServer) {
  mcp.tool(
    "events_near",
    "Find upcoming StageIn events at venues near a given lat/lng coordinate. Note: only ~13% of StageIn venues have geocoded coordinates, so results are best in major Polish cities (Warszawa, Kraków, Wrocław, Poznań, Gdańsk).",
    InputSchema.shape,
    async (input, extra) => {
      const start = Date.now();
      const section = clientSection(undefined);
      const today = new Date().toISOString().slice(0, 10);

      // Use earthdistance ll_to_earth for radius search via raw SQL
      // (Supabase JS doesn't support GIST <@ operator directly)
      const radiusMeters = input.radius_km * 1000;

      const { data, error } = await admin().rpc("events_near_rpc", {
        center_lat: input.latitude,
        center_lng: input.longitude,
        radius_m: radiusMeters,
        result_limit: input.limit,
        today_date: today,
      });

      if (error) throw new Error(`Database error: ${error.message}`);

      const results = (data ?? []).map((row: any) => ({
        id: row.event_id,
        title: row.title,
        date: row.event_date,
        category: row.category,
        price_min: row.price_min,
        currency: "PLN",
        venue: {
          id: row.venue_id,
          name: row.venue_name,
          city: row.venue_city,
          latitude: row.latitude,
          longitude: row.longitude,
        },
        distance_km: Math.round(row.distance_m / 100) / 10,
        permalink: permalink(row.slug),
        affiliate_url: affiliateUrl({
          eventId: row.event_id, source: "alebilet", section,
        }),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results,
            total: results.length,
            search_radius_km: input.radius_km,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
```

## 2A-3.5 RPC function (DB migration for 2A-3)

The geographic search needs server-side SQL because Supabase JS client can't express GIST `<@>` operator. Apply via Supabase MCP `apply_migration`:

```sql
-- Migration: 20260505000000_events_near_rpc.sql
-- Phase 2A-3 — RPC function for geographic event search

CREATE OR REPLACE FUNCTION public.events_near_rpc(
  center_lat double precision,
  center_lng double precision,
  radius_m double precision,
  result_limit integer DEFAULT 20,
  today_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  event_id uuid,
  title text,
  event_date date,
  category text,
  price_min numeric,
  slug text,
  venue_id uuid,
  venue_name text,
  venue_city text,
  latitude double precision,
  longitude double precision,
  distance_m double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    e.id,
    e.title,
    e.event_date,
    e.category,
    e.price_min,
    e.slug,
    v.id,
    v.name,
    v.city,
    v.latitude,
    v.longitude,
    earth_distance(
      ll_to_earth(center_lat, center_lng),
      ll_to_earth(v.latitude, v.longitude)
    ) AS distance_m
  FROM events e
  JOIN venues v ON v.id = e.venue_id
  WHERE e.status = 'active'
    AND e.event_date >= today_date
    AND v.latitude IS NOT NULL
    AND v.longitude IS NOT NULL
    AND earth_box(ll_to_earth(center_lat, center_lng), radius_m) @> ll_to_earth(v.latitude, v.longitude)
    AND earth_distance(
      ll_to_earth(center_lat, center_lng),
      ll_to_earth(v.latitude, v.longitude)
    ) <= radius_m
  ORDER BY distance_m ASC
  LIMIT result_limit;
$$;

COMMENT ON FUNCTION public.events_near_rpc IS
  'Geographic radius search for upcoming events. Uses earthdistance + GIST index on venues. Phase 2A-3.';
```

## 2A-3.6 Test plan

```bash
# search_by_artist tests
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_by_artist","arguments":{"artist_name":"Behemoth"}}}'

curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_by_artist","arguments":{"artist_name":"behemot","limit":5}}}'
# Fuzzy match: "behemot" should still find "Behemoth"

# events_near — Warszawa center coords (52.2297, 21.0122)
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"events_near","arguments":{"latitude":52.2297,"longitude":21.0122,"radius_km":10}}}'

# events_near — Kraków (50.0647, 19.9450)
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"events_near","arguments":{"latitude":50.0647,"longitude":19.9450,"radius_km":50}}}'

# Edge case: invalid lat (over 90)
curl -sS -X POST "$ISSUER" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"events_near","arguments":{"latitude":91,"longitude":0}}}'
```

## 2A-3.7 Acceptance criteria

- [ ] `search_by_artist` returns up to 5 matching artists with their events
- [ ] `search_by_artist` exact match (e.g., "Behemoth") returns top result
- [ ] `search_by_artist` fuzzy match (e.g., "behemot") still finds the artist
- [ ] `search_by_artist` returns empty matches array when no artist found
- [ ] `events_near` returns events with `distance_km` field
- [ ] `events_near` results sorted by distance ascending
- [ ] `events_near` honors `radius_km` parameter
- [ ] `events_near` returns empty array (not error) when no nearby venues
- [ ] Validation: `latitude > 90` rejected by Zod
- [ ] All affiliate_url and permalink fields well-formed

---

# PHASE 2A-4: Recommendation Tool (`recommend_similar`)

## 2A-4.1 Goal

Multi-signal similarity ranking for an "if you liked this, try these" UX. Pivots away from empty mood_tags to Spotify genres + category + venue overlap.

## 2A-4.2 New file

```
supabase/functions/mcp/tools/recommend_similar.ts
```

## 2A-4.3 Algorithm

Given seed `event_id`:

1. Fetch seed event with: artist (and artist.spotify_genres), category, venue.city
2. Find candidates (active, upcoming, NOT seed event_id) with:
   - Same artist_id (perfect match) — score +100
   - OR overlapping spotify_genres (count of overlap × 20)
   - OR same category + same venue.city — score +30
   - OR same category — score +10
3. Sort by total score desc, then by event_date asc, limit to N

This is implemented as a single SQL query for performance (one round trip).

## 2A-4.4 RPC for similarity (DB migration)

Apply via Supabase MCP:

```sql
-- Migration: 20260505000001_recommend_similar_rpc.sql

CREATE OR REPLACE FUNCTION public.recommend_similar_events_rpc(
  seed_event_id uuid,
  result_limit integer DEFAULT 10,
  today_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  event_id uuid,
  title text,
  event_date date,
  category text,
  price_min numeric,
  slug text,
  venue_name text,
  venue_city text,
  artist_name text,
  artist_image_url text,
  similarity_score integer,
  similarity_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  seed_artist_id uuid;
  seed_genres text[];
  seed_category text;
  seed_city text;
BEGIN
  SELECT e.artist_id, a.spotify_genres, e.category, v.city
    INTO seed_artist_id, seed_genres, seed_category, seed_city
  FROM events e
  LEFT JOIN artists a ON a.id = e.artist_id
  LEFT JOIN venues v ON v.id = e.venue_id
  WHERE e.id = seed_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Seed event % not found', seed_event_id;
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.title,
    e.event_date,
    e.category,
    e.price_min,
    e.slug,
    v.name AS venue_name,
    v.city AS venue_city,
    a.name AS artist_name,
    a.spotify_image_url AS artist_image_url,
    (
      CASE WHEN e.artist_id IS NOT NULL AND e.artist_id = seed_artist_id THEN 100 ELSE 0 END +
      CASE WHEN a.spotify_genres && seed_genres THEN
        cardinality(a.spotify_genres & seed_genres) * 20
      ELSE 0 END +
      CASE WHEN e.category = seed_category AND v.city = seed_city THEN 30
           WHEN e.category = seed_category THEN 10
           ELSE 0 END
    )::integer AS similarity_score,
    CASE
      WHEN e.artist_id IS NOT NULL AND e.artist_id = seed_artist_id THEN 'same_artist'
      WHEN a.spotify_genres && seed_genres THEN 'shared_genres'
      WHEN e.category = seed_category AND v.city = seed_city THEN 'same_category_city'
      WHEN e.category = seed_category THEN 'same_category'
      ELSE 'unknown'
    END AS similarity_reason
  FROM events e
  LEFT JOIN artists a ON a.id = e.artist_id
  LEFT JOIN venues v ON v.id = e.venue_id
  WHERE e.id != seed_event_id
    AND e.status = 'active'
    AND e.event_date >= today_date
    AND (
      (e.artist_id IS NOT NULL AND e.artist_id = seed_artist_id) OR
      (a.spotify_genres && seed_genres) OR
      (e.category = seed_category)
    )
  ORDER BY similarity_score DESC, e.event_date ASC
  LIMIT result_limit;
END;
$$;
```

> **Note:** PostgreSQL's `&` operator on text[] computes intersection. `cardinality(a & b)` gives the count.

## 2A-4.5 `tools/recommend_similar.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Seed event UUID — find events similar to this one"),
  limit: z.number().int().min(1).max(20).default(10),
});

export function registerRecommendSimilar(mcp: McpServer) {
  mcp.tool(
    "recommend_similar",
    "Recommend events similar to a seed event. Uses multi-signal scoring: same artist (highest), overlapping Spotify genres, same category + city, then same category. Useful for 'more like this' UX.",
    InputSchema.shape,
    async (input, extra) => {
      const start = Date.now();
      const section = clientSection(undefined);

      const { data, error } = await admin().rpc("recommend_similar_events_rpc", {
        seed_event_id: input.event_id,
        result_limit: input.limit,
        today_date: new Date().toISOString().slice(0, 10),
      });

      if (error) {
        if (error.message.includes("Seed event") && error.message.includes("not found")) {
          throw new Error(`Event not found: ${input.event_id}`);
        }
        throw new Error(`Database error: ${error.message}`);
      }

      const results = (data ?? []).map((row: any) => ({
        id: row.event_id,
        title: row.title,
        date: row.event_date,
        category: row.category,
        price_min: row.price_min,
        currency: "PLN",
        venue: { name: row.venue_name, city: row.venue_city },
        artist: row.artist_name ? {
          name: row.artist_name,
          image_url: row.artist_image_url,
        } : null,
        similarity_score: row.similarity_score,
        similarity_reason: row.similarity_reason,
        permalink: permalink(row.slug),
        affiliate_url: affiliateUrl({
          eventId: row.event_id, source: "alebilet", section,
        }),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            seed_event_id: input.event_id,
            recommendations: results,
            total: results.length,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
```

## 2A-4.6 Acceptance criteria

- [ ] `recommend_similar` returns up to N recommendations sorted by score desc
- [ ] Each result includes `similarity_score` (integer 0-200ish) and `similarity_reason` enum
- [ ] Same-artist matches always score highest
- [ ] Genre overlap matches return shared_genres reason
- [ ] Seed event itself never appears in results
- [ ] Returns empty array (not error) when no similar events found
- [ ] Error for non-existent event_id

---

# PHASE 2B-1: Write Tools

## 2B-1.1 Goal

Three subscription tools that write to per-user tables. All require user identity from JWT (auth.users.email).

## 2B-1.2 Files

```
supabase/functions/mcp/tools/
├── track_price.ts
├── follow_artist.ts
└── subscribe_newsletter.ts
```

## 2B-1.3 `tools/track_price.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { getUserEmail } from "../lib/user.ts";

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Event to track price for"),
});

export function registerTrackPrice(mcp: McpServer) {
  mcp.tool(
    "track_price",
    "Subscribe to price drop alerts for a StageIn event. The user will be notified by email when the cheapest available ticket becomes cheaper than the current price.",
    InputSchema.shape,
    async (input, extra) => {
      const auth = extra?.context?.get?.("auth"); // depends on MCP SDK context plumbing
      const user_id = auth?.user_id;
      if (!user_id) throw new Error("Authentication required");

      const email = await getUserEmail(user_id);
      if (!email) throw new Error("User email not found");

      // Look up current cheapest price + source
      const { data: cheapest, error: priceErr } = await admin()
        .from("listings")
        .select("price_min, source, event_id")
        .eq("event_id", input.event_id)
        .eq("is_available", true)
        .not("price_min", "is", null)
        .order("price_min", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (priceErr) throw new Error(`Database error: ${priceErr.message}`);
      if (!cheapest) throw new Error("No available tickets to track for this event");

      // Verify event exists and is active
      const { data: evt, error: evtErr } = await admin()
        .from("events")
        .select("id, title, status, event_date")
        .eq("id", input.event_id)
        .maybeSingle();
      if (evtErr || !evt) throw new Error(`Event not found: ${input.event_id}`);
      if (evt.status !== "active") throw new Error("Event is not active");

      // Check duplicate
      const { data: existing } = await admin()
        .from("price_alerts")
        .select("id")
        .eq("email", email)
        .eq("event_id", input.event_id)
        .eq("is_active", true)
        .maybeSingle();

      if (existing) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: `You're already tracking price for "${evt.title}". No duplicate alert created.`,
              resource_id: existing.id,
            }),
          }],
        };
      }

      // Insert
      const { data: inserted, error: insErr } = await admin()
        .from("price_alerts")
        .insert({
          email,
          event_id: input.event_id,
          price_at_alert: cheapest.price_min,
          source: cheapest.source,
        })
        .select("id")
        .single();

      if (insErr) throw new Error(`Failed to create price alert: ${insErr.message}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            message: `Price alert created for "${evt.title}". You'll be notified at ${email} when the price drops below ${cheapest.price_min} PLN.`,
            resource_id: inserted.id,
          }),
        }],
      };
    }
  );
}
```

> **Note on context plumbing:** The exact API for retrieving Hono context inside MCP SDK tool handlers depends on `@hono/mcp` integration details. Two patterns to try:
>
> 1. The `extra` parameter in `mcp.tool()` handler may include request context.
> 2. We may need to plumb a per-request mcp instance (create new server per request) with closure over auth.
>
> If pattern 1 doesn't work, restructure: in `index.ts`, MCP route handler creates a fresh `McpServer` per request, calls `registerTools(mcp, c.get("auth"))`, then connects transport. Tools take `auth` as registration parameter, close over it. This adds slight overhead (server creation per request) but isolates auth correctly.
>
> Verify approach in PR 2A-1 before designing 2B around it.

## 2B-1.4 `tools/follow_artist.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { getUserEmail } from "../lib/user.ts";

const InputSchema = z.object({
  artist_id: z.string().uuid().describe("Artist UUID to follow"),
});

export function registerFollowArtist(mcp: McpServer) {
  mcp.tool(
    "follow_artist",
    "Follow an artist on StageIn. The user will receive email notifications when this artist announces new events.",
    InputSchema.shape,
    async (input, extra) => {
      const auth = extra?.context?.get?.("auth");
      const user_id = auth?.user_id;
      if (!user_id) throw new Error("Authentication required");

      const email = await getUserEmail(user_id);
      if (!email) throw new Error("User email not found");

      const { data: artist } = await admin()
        .from("artists")
        .select("id, name")
        .eq("id", input.artist_id)
        .maybeSingle();
      if (!artist) throw new Error(`Artist not found: ${input.artist_id}`);

      const { data: existing } = await admin()
        .from("artist_follows")
        .select("id")
        .eq("email", email)
        .eq("artist_id", input.artist_id)
        .eq("is_active", true)
        .maybeSingle();

      if (existing) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: `You're already following ${artist.name}.`,
              resource_id: existing.id,
            }),
          }],
        };
      }

      const { data: inserted, error } = await admin()
        .from("artist_follows")
        .insert({ email, artist_id: input.artist_id })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to follow artist: ${error.message}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            message: `Now following ${artist.name}. You'll be notified at ${email} when new events are announced.`,
            resource_id: inserted.id,
          }),
        }],
      };
    }
  );
}
```

## 2B-1.5 `tools/subscribe_newsletter.ts`

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { getUserEmail } from "../lib/user.ts";

const InputSchema = z.object({
  city: z.string().optional().describe("Preferred city for event recommendations (e.g., 'Warszawa')"),
  preferences: z.array(z.string()).max(10).optional()
    .describe("List of category preferences (e.g., ['MUZYKA', 'STAND-UP'])"),
});

export function registerSubscribeNewsletter(mcp: McpServer) {
  mcp.tool(
    "subscribe_newsletter",
    "Subscribe to the StageIn weekly newsletter — curated event recommendations delivered every Friday. Optional: filter by city and category preferences.",
    InputSchema.shape,
    async (input, extra) => {
      const auth = extra?.context?.get?.("auth");
      const user_id = auth?.user_id;
      if (!user_id) throw new Error("Authentication required");

      const email = await getUserEmail(user_id);
      if (!email) throw new Error("User email not found");

      // Check existing subscription
      const { data: existing } = await admin()
        .from("newsletter_subscribers")
        .select("id, is_active, confirmed")
        .eq("email", email)
        .maybeSingle();

      if (existing && existing.is_active && existing.confirmed) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: "You're already subscribed to the StageIn newsletter.",
              resource_id: existing.id,
            }),
          }],
        };
      }

      if (existing) {
        // Re-activate or update
        const { data: updated, error } = await admin()
          .from("newsletter_subscribers")
          .update({
            is_active: true,
            city: input.city ?? null,
            preferences: input.preferences ?? [],
          })
          .eq("id", existing.id)
          .select("id")
          .single();
        if (error) throw new Error(`Failed to update subscription: ${error.message}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: existing.confirmed
                ? "Subscription preferences updated."
                : "Subscription re-activated. Check your email to confirm.",
              resource_id: updated.id,
            }),
          }],
        };
      }

      // New subscription
      const confirmation_token = crypto.randomUUID();
      const { data: inserted, error } = await admin()
        .from("newsletter_subscribers")
        .insert({
          email,
          city: input.city ?? null,
          preferences: input.preferences ?? [],
          confirmation_token,
          confirmed: false,
          is_active: true,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to subscribe: ${error.message}`);

      // Note: actual confirmation email is sent by separate StageIn worker
      // that watches newsletter_subscribers inserts. Out of scope here.

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            message: `Subscription created. Check your email at ${email} to confirm.`,
            resource_id: inserted.id,
          }),
        }],
      };
    }
  );
}
```

## 2B-1.6 Acceptance criteria

- [ ] `track_price`: creates row in `price_alerts` with email from JWT, captures current cheapest price
- [ ] `track_price`: idempotent (duplicate call returns existing alert)
- [ ] `track_price`: rejects when no available listings exist
- [ ] `follow_artist`: creates row in `artist_follows`
- [ ] `follow_artist`: idempotent
- [ ] `follow_artist`: rejects unknown artist_id
- [ ] `subscribe_newsletter`: creates row with `confirmed: false`, generates confirmation_token
- [ ] `subscribe_newsletter`: idempotent for already-confirmed users
- [ ] All write tools fail with clear error if Bearer JWT is missing or invalid
- [ ] All return `{ok, message, resource_id}` shape

---

# PHASE 2C-1: Affiliate Section Tagging

## 2C-1.1 Goal

Currently every tool tags affiliate clicks with `mcp:unknown`. Phase 2C properly derives section from JWT `client_id` → DB lookup → `client_name` → `clientSection()`.

## 2C-1.2 Single change

In each tool, replace:

```ts
const section = clientSection(undefined);
```

With:

```ts
const auth = extra?.context?.get?.("auth");
const clientName = auth?.client_id 
  ? await getClientName(auth.client_id)  // new helper, looks up mcp_oauth_clients
  : undefined;
const section = clientSection(clientName);
```

Add `lib/oauth_client.ts`:

```ts
import { admin } from "./supabase.ts";

const cache = new Map<string, string>();

export async function getClientName(client_id: string): Promise<string | undefined> {
  if (cache.has(client_id)) return cache.get(client_id);
  const { data } = await admin()
    .from("mcp_oauth_clients")
    .select("client_name")
    .eq("client_id", client_id)
    .maybeSingle();
  if (data?.client_name) {
    cache.set(client_id, data.client_name);
    return data.client_name;
  }
  return undefined;
}
```

In-memory cache acceptable because Edge Function instances are short-lived (cold start every few minutes); cache miss penalty is negligible.

## 2C-1.3 Acceptance criteria

- [ ] After registering DCR client `Claude` and authenticating, affiliate URLs from any tool include `section=mcp:claude`
- [ ] Same for ChatGPT, Cursor (test via separate DCR registrations)
- [ ] Unknown client → `mcp:unknown` (graceful)
- [ ] Cache hit on second call (verify by Supabase Logs — should NOT see SELECT after first call)

---

# 4. End-to-end test scenarios

## E2E-2A — Full read flow with Claude.ai-style client

After 2A-4 merged, simulate Claude.ai's typical flow:

```
1. Discovery: GET /.well-known/oauth-authorization-server
2. Register: POST /oauth/register (client_name: "Claude")
3. Authorize → email → callback → token (Stage 2 of Phase 1C-2 + token exchange)
4. tools/list → expect 6 read tools
5. search_events query="weekend" date_from=today
6. get_event for first result
7. find_cheapest_ticket for same event
8. recommend_similar for same event
9. search_by_artist for artist from result
10. events_near for venue lat/lng of first result
```

Each step should succeed end-to-end with valid Bearer token, sub-second latency.

## E2E-2B — Write flow

After 2B-1:

```
1-3. (auth as above)
4. search_events to find an event
5. track_price for that event → expect ok: true
6. follow_artist for the event's artist → expect ok: true
7. subscribe_newsletter with city: "Warszawa" → expect ok: true
8. Verify in DB: 1 row in price_alerts, 1 in artist_follows, 1 in newsletter_subscribers
9. Replay step 5 → expect "already tracking" (idempotent)
```

## E2E-2C — Affiliate tracking

After 2C-1, with two registered clients ("Claude", "ChatGPT"):

```
1. As Claude client, search_events → check affiliate_url contains section=mcp:claude
2. As ChatGPT client, search_events → check affiliate_url contains section=mcp:chatgpt
3. Click test affiliate_url manually → verify affiliate_clicks row gets correct section value
```

---

# 5. Risks

## R1: MCP SDK context plumbing for auth

The most uncertain part is how to get `c.get("auth")` (set by Bearer middleware in Phase 1C-3) inside tool handlers. Three patterns to try, in order:

1. **`extra` parameter in tool handler** — newer MCP SDK versions expose request context here
2. **Per-request McpServer instance** — restructure index.ts MCP route to create new mcp + register tools with closure over auth on every request
3. **Module-level `AsyncLocalStorage`** — set context at request entry in middleware, read in tool handlers via `als.getStore()`

**Action:** Verify pattern 1 in PR 2A-1 first tool. If it doesn't work, switch to pattern 2 before continuing 2A-2.

## R2: Concurrent listings updates during track_price

When `track_price` snapshots `price_at_alert`, listings might be updating concurrently. Acceptable for v1: snapshot at insert time, accept eventual consistency.

## R3: `auth.users.getUserById` rate limit

If we call `getUserEmail` on every write tool invocation, we hit Supabase Auth API frequently. Phase 3 hardening: cache email by user_id with 5-min TTL.

## R4: Polish/English mixing in tool descriptions

User-facing data is Polish (event titles), tool-facing descriptions are English. AI clients sometimes get confused. Mitigation: explicit hint in tool descriptions ("returns Polish-language event data").

## R5: Empty mood_tags assumption

`recommend_similar` falls back to category+venue when no genre overlap. If StageIn populates mood_tags later, add it as additional signal in RPC without breaking change.

## R6: Performance on large search_events queries

`textSearch("fts", ...)` with no other filters may return thousands of rows. We `limit()` but DB still scans. If p95 slips above 300ms, add `range(0, limit-1)` instead of pure limit, plus stricter requirement: at least one of (category | city | date_from) must be set when query is empty.

---

# 6. Decision log

**Q: Why Spotify genres over mood_tags for similarity?**
A: mood_tags has 0 populated rows in production (verified 2026-05-04). spotify_genres is populated for most artists via existing StageIn enrichment pipeline.

**Q: Why per-PR slicing of 4 reads + 1 writes + 1 affiliate vs. one big PR?**
A: Each PR gates failure. If 2A-3 (geo) breaks, 2A-1/2A-2 are already merged and stable. Big PR would mean rolling back 6 things to fix 1.

**Q: Why not return MCP errors via tool result instead of throwing?**
A: MCP SDK convention: throw → SDK serializes to MCP error response. Tools-returning-errors create ambiguity (is `ok: false` an error or normal flow?).

**Q: Why limit search_events to 50?**
A: Token budget. Even compact JSON, 50 events ≈ 30KB which is reasonable. 100+ starts hurting context windows of consumer LLMs.

**Q: Why no GraphQL-style field selection?**
A: MCP doesn't support partial selection. Each tool returns its full intended shape. If clients need less, they can ignore fields.

**Q: Should write tools double-confirm (e.g., "are you sure you want to subscribe?")?**
A: No. MCP convention: tool execution implies user consent (the human in the loop already approved at Claude.ai's tool-call confirmation step). Don't double-confirm.

---

# 7. When in doubt

- **MCP SDK API quirks:** The library is new and changing. Check `@modelcontextprotocol/sdk@1.29` source on GitHub before guessing.
- **Supabase JS client subtleties:** `.maybeSingle()` returns null on no row, `.single()` errors. `.select()` argument syntax for nested relations.
- **Polish-language data formatting:** Don't lowercase Polish event titles or artist names. Pass through verbatim.
- **Affiliate URL precision:** Wrong section tag = wrong attribution = lost revenue tracking. Test E2E-2C carefully.

---

**End of Phase 2 spec.**
