# STAGEIN MCP SERVER — PLAN IMPLEMENTACJI

**Wersja:** v0.2
**Data:** 30 kwietnia 2026
**Owner:** Przemysław Kołakowski
**Status:** decyzje zaakceptowane, gotowe do startu fazy 0

**Changelog v0.2 vs v0.1:**
- Hosting: Cloudflare Workers → **Supabase Edge Function** (zero nowej infrastruktury, niższa latencja DB)
- Auth: zaplanowane na v2 → **wchodzi w v1** (OAuth 2.1 bridge + Supabase Auth magic-link)
- Click tracking: planowany `/go/[id]` → **istnieje** jako `/api/redirect?eventId=&source=&section=&listingId=`, MCP traffic tagowany przez `section=mcp:{client}`
- Zakres v1: 6 read tools → **9 narzędzi** (6 read + 3 write)
- Czas: 10-12 dni → 13-15 dni dev effort
- URL eventu: `/wydarzenie/[slug]` → **`/event/[slug]`** (zweryfikowane na produkcji)

---

## Spis treści

1. [Cele i kontekst biznesowy](#1-cele-i-kontekst-biznesowy)
2. [Założenia techniczne](#2-założenia-techniczne)
3. [Decyzje architektoniczne](#3-decyzje-architektoniczne)
4. [Zakres funkcjonalny v1](#4-zakres-funkcjonalny-v1)
5. [Compliance i prywatność](#5-compliance-i-prywatność)
6. [Co NIE wchodzi w v1](#6-co-nie-wchodzi-w-v1)
7. [Plan fazowy](#7-plan-fazowy)
8. [Lista rzeczy do wykonania](#8-lista-rzeczy-do-wykonania)
9. [Pre-launch checklist](#9-pre-launch-checklist)
10. [Otwarte pytania (do decyzji)](#10-otwarte-pytania-do-decyzji)
11. [Roadmapa post-launch](#11-roadmapa-post-launch)
12. [Ryzyka i mitygacje](#12-ryzyka-i-mitygacje)

---

## 1. Cele i kontekst biznesowy

### Cel główny
Udostępnienie StageIn jako MCP server, dzięki czemu użytkownicy Claude, ChatGPT, Cursor, Continue, Windsurf i innych klientów MCP mogą bezpośrednio z poziomu czatu wyszukiwać wydarzenia i bilety z polskiego rynku, agregowane z 7 źródeł sprzedaży.

### Cele wtórne
- Dystrybucja affiliate — każdy zwracany URL prowadzi do strony partnera (TM, AleBilet, eBilet, Going, Eventim, Biletomat, Empikbilety) z parametrami affiliate, które już są w bazie w polach `events.affiliate_url` i `listings.affiliate_url`.
- Pozycjonowanie StageIn jako "default" agregatora biletów dla polskojęzycznych zapytań w AI assistantach.
- Eksperymentalna platforma do testowania kanałów dystrybucji AI przed inwestycją w pełny ekosystem (Apps SDK UI, Agentic Commerce).

### Czego MCP server NIE zastępuje
MCP nie zastępuje SEO ani strony web. Realny wolumen ruchu pochodzi i będzie pochodził z AI search (Perplexity, ChatGPT search, Claude search) i Google. MCP to dodatkowy kanał o wysokiej jakości intencji ("daj mi bilet na X"), ale niskim wolumenie.

---

## 2. Założenia techniczne

### 2.1 Stack
- **Runtime:** Supabase Edge Function (Deno + TypeScript). Decyzja: trzymamy MCP server w istniejącym stacku StageIn, bez wprowadzania trzeciego providera (CF). Edge Function siedzi w tym samym regionie co baza Postgres, oszczędność 20-50ms latency per DB call.
- **Routing:** wbudowany router Edge Function (Hono opcjonalnie, jeśli zwiększy czytelność).
- **MCP SDK:** `@modelcontextprotocol/sdk` (Deno-compatible build).
- **Walidacja:** Zod.
- **Database:** Supabase (`zrirjplulfqmjgtdwspt`) przez wbudowany Postgres pool w Edge Function z `service_role` (`SUPABASE_SERVICE_ROLE_KEY` w secrets).
- **Domena:** `mcp.stagein.pl` (CNAME do `[ref].functions.supabase.co`).
- **Repo:** nowe `przemek-arch/stagein-mcp` ze strukturą Supabase (`supabase/functions/mcp/` + `supabase/migrations/`). Standalone, oddzielne od `stagein` (frontend).
- **Transport MCP:** Streamable HTTP (SSE jako fallback zachowany do końca 2026).
- **Auth:** w v1. OAuth 2.1 bridge w Edge Function z Dynamic Client Registration, magic-link przez Supabase Auth jako backend. Endpoints: `/oauth/register`, `/oauth/authorize`, `/oauth/token`. ~150-200 linii kodu.
- **Rate limiting:** tabela `mcp_rate_limit` z `INSERT ... ON CONFLICT (ip, window) DO UPDATE SET count = count + 1`, indeks na `(ip, window)`. Sliding window 60 req/min.

### 2.2 Performance i SLA
- p95 latency `search_events` < 300ms (region EU).
- p95 latency `get_event` < 200ms.
- p95 latency `events_near` < 400ms.
- Dostępność: best-effort, brak SLA. Cloudflare globalny edge, więc realnie 99.9%+.

### 2.3 Limity zasobów
- Maks 50 wyników per `search_events` (token budget AI).
- Description w odpowiedzi truncate do 500 znaków.
- Maks 1 MB total response per tool call.
- Rate limit: 60 req/min per IP (CF KV counter), burst 10 req w 10s.

### 2.4 Język
- Descriptions narzędzi w EN (wymóg AI clientów).
- Wartości tekstowe (`title`, `subtitle`, `description`, `bio_pl`) zwracane natywnie po polsku.
- Komunikaty błędów: EN.

---

## 3. Decyzje architektoniczne

### 3.1 Hosting: Supabase Edge Function
**Powód:** zero nowej infrastruktury. StageIn już ma Supabase + Vercel — Edge Function nie wymaga trzeciego providera (CF Workers), osobnego billing'u, dashboardu, sekretów ani CI/CD. Function siedzi w tym samym regionie co Postgres, niższa latencja DB calls. `supabase functions deploy mcp` jednym poleceniem.

Co tracimy vs CF Workers: granularność edge (Supabase ~12 regionów vs CF 300+) — nieistotne, bo klient AI (Claude/ChatGPT) i tak siedzi w jednym regionie i to on robi roundtrip do MCP.

### 3.2 Auth strategy
**v1 z OAuth 2.1.** OAuth bridge w Edge Function: `/oauth/register` (Dynamic Client Registration zgodnie z 6/18 spec MCP), `/oauth/authorize` (redirect na Supabase magic-link), `/oauth/token` (wymiana code → access_token = Supabase JWT).

Magic-link flow: użytkownik MCP klika "Connect" w Claude/ChatGPT → redirect na `/oauth/authorize` → email z linkiem → po kliknięciu Supabase tworzy session → bridge wystawia OAuth access token.

Read tools są dostępne **bez auth** (publiczne). Auth wymagany tylko dla write tools (track_price, follow_artist, subscribe_newsletter). Klient bez auth dostaje na czytaniu, ale write zwraca `401 Unauthorized` z hint URL do auth flow.

### 3.3 Database access
Edge Function łączy się z Supabase przez `service_role` key trzymany w `SUPABASE_SERVICE_ROLE_KEY` secret. RLS pozostaje włączony, ale Edge Function go bypassuje — uprawnienia są egzekwowane na poziomie kodu (sztywne `WHERE status='active' AND event_date >= CURRENT_DATE`).

**Alternatywa odrzucona:** użycie `anon` key z RLS policies. Powód odrzucenia: czystsze utrzymywanie polityk biznesowych w jednym miejscu, brak ryzyka błędu w policy ujawniającego dane.

### 3.4 Affiliate tracking — istniejący endpoint
**Endpoint produkcyjny:** `https://stagein.pl/api/redirect?eventId={uuid}&source={partner}&section={location}&listingId={uuid}`. Loguje do `affiliate_clicks` (event_id, source, section, listing_id, session_id, clicked_at) i robi 302 do partnera z parametrami affiliate.

**Tagowanie MCP traffic:** parametr `section=mcp:{client}` gdzie client to `claude`, `chatgpt`, `cursor`, lub `unknown`. Wnioskowanie z User-Agent lub `_meta.client_name` z MCP request. Schema bazy nie wymaga zmian — `section` jest nullable text.

**Implikacja:** zero pracy frontendowej w stagein. MCP zwraca URLe w istniejącym formacie. Analytics przez `WHERE section LIKE 'mcp:%'`.

### 3.5 Caching
- Edge cache (Supabase) 60s na `search_events` (klucz: hash query+filters).
- Edge cache 300s na `get_event`, `search_by_artist`, `recommend_similar`.
- Brak cache na `events_near` (parametry lat/lng nieprzewidywalne).
- Cache invalidation: TTL only.

### 3.6 Schema response
Każdy tool zwraca `content: [{type: "text", text: "..."}]` ze structured JSON jako string. Maksymalna kompatybilność (część klientów MCP nie obsługuje resource embeddings).

W przyszłości (Apps SDK / MCP UI) dorzucamy `_meta` z hintami dla renderowania.

### 3.7 URL eventu w response
**Format:** `https://stagein.pl/event/[slug]` (nie `/wydarzenie/`). Każda odpowiedź `search_events` i `get_event` zawiera pole `permalink`. Slug ma postać `[title-slug]-[YYYY-MM-DD]` — `get_event` przyjmuje zarówno UUID jak i pełny slug jako input.

---

## 4. Zakres funkcjonalny v1

**Sześć read-only narzędzi + trzy write narzędzia + OAuth bridge.** Decyzja: auth idzie od razu, więc pełen v1 ma 9 narzędzi.

### Read tools (bez auth)

### 4.1 `search_events`
**Wejście:** `query: string?`, `city: string?`, `date_from: string?` (ISO), `date_to: string?`, `price_max: number?`, `category: string?`, `mood_tags: string[]?`, `limit: number = 10` (max 50).

**Logika:** FTS query na `events.fts` (jeśli `query` podany) + filtry, JOIN `venues`, sort po `event_date ASC`. Filtry domyślne: `status='active' AND event_date >= CURRENT_DATE`.

**Wyjście:** lista eventów z `id`, `slug`, `title`, `subtitle`, `event_date`, `event_time`, `venue_name`, `city`, `price_min`, `price_max`, `category`, `image_url`, `permalink` (`https://stagein.pl/event/{slug}`), `affiliate_url` (`/api/redirect?...&section=mcp:{client}`).

### 4.2 `get_event`
**Wejście:** `id_or_slug: string` (akceptuje UUID lub pełny slug typu `kortez-2026-04-30`).

**Logika:** SELECT pełny event + JOIN venue + JOIN artist + LEFT JOIN listings (sortowane po `price_min` ASC, tylko `is_available=true`).

**Wyjście:** pełny event + venue (z lat/lng) + artist (Spotify, bio_pl) + array listings (po jednym per source z najlepszą ceną) + `permalink`.

### 4.3 `find_cheapest_ticket`
**Wejście:** `id_or_slug: string`.

**Logika:** SELECT z `listings` WHERE `event_id` AND `is_available=true` ORDER BY `price_min` ASC LIMIT 5.

**Wyjście:** top 5 listings z `source`, `price_min`, `price_max`, `sale_type` (primary/resale), `affiliate_url` (z `section=mcp:{client}` i konkretnym `listingId`), `currency`.

### 4.4 `search_by_artist`
**Wejście:** `artist_name: string`.

**Logika:** Match artist przez `pg_trgm` similarity (włączyć extension), JOIN events upcoming, sort po `event_date` ASC.

**Wyjście:** artist info (`name`, `spotify_genres`, `spotify_image_url`, `bio_pl`, `spotify_top_tracks` ograniczone do 3) + lista upcoming events.

### 4.5 `events_near`
**Wejście:** `latitude: number`, `longitude: number`, `radius_km: number = 50` (max 200), `date_from: string?`, `date_to: string?`, `limit: number = 10` (max 30).

**Logika:** użycie `earth_distance(ll_to_earth(...))` (extension `earthdistance` + `cube`), filter `<= radius_km * 1000`, sort po dystansie ASC.

**Wyjście:** events + venue z polem `distance_km`.

### 4.6 `recommend_similar`
**Wejście:** `event_id: string`, `limit: number = 5` (max 10).

**Logika:** events z overlap w `mood_tags` ARRAY, taka sama `category`, exclude original, future events, sort po liczbie wspólnych tagów DESC, potem po `event_date` ASC.

**Wyjście:** podobne events (ten sam format co `search_events`).

### Write tools (wymagają auth)

### 4.7 `track_price`
**Wejście:** `event_id: string`, `max_price: number`, `email: string?` (jeśli nie podany, brany z auth context).

**Logika:** INSERT do `price_alerts` (event_id, email, price_at_alert=current min, is_active=true). Sprawdzenie czy alert już istnieje dla tej kombinacji.

**Wyjście:** `alert_id`, `current_price`, `target_price`, `permalink`.

**Annotation:** `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true` (drugi call z tymi samymi parametrami = update).

### 4.8 `follow_artist`
**Wejście:** `artist_name_or_id: string`, `email: string?` (z auth context).

**Logika:** Resolve artist → INSERT do `artist_follows` (artist_id, email, is_active=true).

**Wyjście:** `artist_id`, `artist_name`, `confirmation_email_sent: boolean`.

**Annotation:** `readOnlyHint=false`, `idempotentHint=true`.

### 4.9 `subscribe_newsletter`
**Wejście:** `city: string?`, `categories: string[]?`, `email: string?` (z auth context).

**Logika:** INSERT do `newsletter_subscribers` z `confirmed=false` + wysłanie confirmation email (przez Supabase Auth lub osobny edge function `send-confirmation`).

**Wyjście:** `subscriber_id`, `email`, `requires_confirmation: true`.

**Annotation:** `readOnlyHint=false`, `idempotentHint=false`, `openWorldHint=true`.

---

## 5. Compliance i prywatność

### 5.1 Privacy policy
StageIn musi mieć zaktualizowaną politykę prywatności pokrywającą MCP server. Wymagana sekcja zawierająca:
- Jakie dane zbiera worker (IP dla rate limitingu, query params, timestamp).
- Retention: 24h dla raw logs, agregaty bez PII bezterminowo.
- Brak transferu danych do third parties poza partnerami afiliacyjnymi (przy kliknięciu w URL).
- Endpoint kontaktowy (GDPR access/erasure).

### 5.2 GDPR
Dane przetwarzane w MCP server nie zawierają PII użytkowników StageIn. Logi worker'a mają IP, ale są anonimizowane w 24h (skracane do /24 dla v4, /48 dla v6). Affiliate clicks już są anonimowe (`session_id` losowy, nie powiązany z kontem).

### 5.3 Tool annotations (kluczowe dla submission)
Każdy tool v1 oznaczony:
- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: true` (czyta dane z bazy zewnętrznej dla AI clienta)
- `idempotentHint: true`

### 5.4 OpenAI Apps Directory — uwagi
- Brak commerce wewnątrz ChatGPT (tylko external checkout). ✓ Spełnione — wszystkie URL prowadzą do partnerów.
- Identity verification (business) wymagana przed submission. **Do wykonania.**
- Demo account nie potrzebny (brak auth w v1).

---

## 6. Co NIE wchodzi w v1

- ~~Auth/OAuth — w v2.~~ **Wchodzi w v1.**
- ~~Write tools — w v2.~~ **Wchodzą w v1** (`track_price`, `follow_artist`, `subscribe_newsletter`).
- Semantic search z `pgvector` — w v2.
- MCP UI / Apps SDK widgets — w v3 (po dystrybucji v1).
- Multi-language descriptions po stronie tooli — w v3.
- GraphQL endpoint (przez `pg_graphql`) — opcjonalnie kiedyś.
- Webhooks dla event changes — out of scope.
- Real-time inventory (w przyszłości przez Supabase Realtime).
- Custom UI w Claude.ai (Anthropic MCP Apps) — w v3.
- Stripe Connect / Agentic Commerce — w v4.

---

## 7. Plan fazowy

| Faza | Cel | Szacowany czas |
|---|---|---|
| 0 — Pre-flight | Akceptacja założeń, repo, branding decisions | 1 dzień |
| 1 — Foundation | DB migrations, Edge Function skeleton, manifest, OAuth bridge | 3 dni |
| 2 — Read tools | Implementacja 6 narzędzi z testami | 3-4 dni |
| 3 — Write tools | 3 narzędzia + auth integration + email confirmation flow | 2-3 dni |
| 4 — Hardening | Rate limit, cache, error handling, perf testy | 1-2 dni |
| 5 — Branding & docs | Logo, screenshots, README, privacy update, demo account dla OpenAI | 2 dni |
| 6 — Submission | Smithery, MCP registry, Anthropic, OpenAI | 1 dzień + 2-4 tyg review |

**Total dev time:** ~13-15 dni effort, ~3-4 tygodnie kalendarzowo.

---

## 8. Lista rzeczy do wykonania

### Faza 0 — Pre-flight (1 dzień)

- [x] ~~Akceptacja założeń sekcji 1-6.~~ **Zrobione.**
- [x] ~~Decyzje na otwarte pytania (sekcja 10).~~ **Wszystkie rozstrzygnięte.**
- [ ] Założenie repo `przemek-arch/stagein-mcp` (Supabase project structure).
- [ ] Inicjalizacja Supabase CLI w repo: `supabase init`.
- [ ] Setup struktury katalogów:
  ```
  /supabase/functions/mcp/
    index.ts             ← entry point
    tools/
      search_events.ts
      get_event.ts
      ... (9 tools)
    lib/
      supabase.ts
      affiliate.ts
      auth.ts
      ratelimit.ts
      cache.ts
      errors.ts
    oauth/
      register.ts
      authorize.ts
      token.ts
  /supabase/migrations/
  /docs/
  README.md
  PRIVACY.md
  ```
- [ ] Konfiguracja branch protection na `main`.
- [ ] Setup GitHub Actions: typecheck + Deno lint + auto-deploy via `supabase functions deploy mcp` na merge do main.
- [ ] Custom domain setup: CNAME `mcp.stagein.pl` → `[ref].functions.supabase.co` w Supabase Dashboard.

### Faza 1 — Foundation (3 dni)

#### 1A. Database migrations

- [ ] `2026_05_01_enable_extensions.sql`:
  ```sql
  CREATE EXTENSION IF NOT EXISTS earthdistance;
  CREATE EXTENSION IF NOT EXISTS cube;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  ```
- [ ] `2026_05_01_indexes_for_mcp.sql`:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_events_active_upcoming
    ON events(event_date, status)
    WHERE status='active' AND event_date >= CURRENT_DATE;

  CREATE INDEX IF NOT EXISTS idx_events_fts
    ON events USING GIN(fts);

  CREATE INDEX IF NOT EXISTS idx_events_artist
    ON events(artist_id) WHERE artist_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_events_mood_tags
    ON events USING GIN(mood_tags);

  CREATE INDEX IF NOT EXISTS idx_listings_event_avail
    ON listings(event_id, is_available, price_min)
    WHERE is_available=true;

  CREATE INDEX IF NOT EXISTS idx_venues_geo
    ON venues USING GIST(ll_to_earth(latitude, longitude))
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_artists_name_trgm
    ON artists USING GIN(name gin_trgm_ops);
  ```
- [ ] `2026_05_02_mcp_rate_limit.sql`:
  ```sql
  CREATE TABLE mcp_rate_limit (
    ip text NOT NULL,
    window timestamp with time zone NOT NULL,
    count integer DEFAULT 1,
    PRIMARY KEY (ip, window)
  );
  CREATE INDEX idx_mcp_rate_limit_window ON mcp_rate_limit(window);

  -- Cleanup function (puszczamy raz/godz przez pg_cron)
  CREATE OR REPLACE FUNCTION cleanup_rate_limit()
  RETURNS void AS $$
    DELETE FROM mcp_rate_limit WHERE window < now() - interval '1 hour';
  $$ LANGUAGE sql;

  -- Schedule cleanup
  SELECT cron.schedule('cleanup-mcp-rate-limit', '0 * * * *', 'SELECT cleanup_rate_limit()');
  ```
- [ ] `2026_05_02_mcp_oauth_clients.sql`:
  ```sql
  -- Dla Dynamic Client Registration (RFC 7591)
  CREATE TABLE mcp_oauth_clients (
    client_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_secret text NOT NULL,
    redirect_uris text[] NOT NULL,
    client_name text,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone
  );

  -- Authorization codes (short-lived, 10 min)
  CREATE TABLE mcp_oauth_codes (
    code text PRIMARY KEY,
    client_id uuid REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text,
    code_challenge_method text,
    expires_at timestamp with time zone NOT NULL
  );
  CREATE INDEX idx_mcp_oauth_codes_expires ON mcp_oauth_codes(expires_at);
  ```
- [ ] Run `EXPLAIN ANALYZE` na każdym z 6 read query, zapisać baseline w `docs/performance-baseline.md`.
- [ ] Decyzja: `v_events_full` view (na podstawie pomiarów).

#### 1B. Edge Function skeleton

- [ ] `supabase functions new mcp`.
- [ ] Secrets: `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...`.
- [ ] Install deno deps przez `import_map.json`: MCP SDK, Zod, postgres client.
- [ ] `/health` route (GET, zwraca `{status: "ok", version, uptime}`).
- [ ] `/manifest` route (server name, description, contact, capabilities, auth metadata).
- [ ] `/mcp` route z transportem Streamable HTTP, lista tools (na razie pusta).
- [ ] Lokalny test: `supabase functions serve mcp --env-file ./supabase/.env.local` + `npx @modelcontextprotocol/inspector http://localhost:54321/functions/v1/mcp`.

#### 1C. OAuth bridge

- [ ] `oauth/register.ts` — implementacja DCR (RFC 7591), INSERT do `mcp_oauth_clients`.
- [ ] `oauth/authorize.ts` — PKCE check, generowanie code, INSERT do `mcp_oauth_codes`, redirect na `/auth/magic-link?code=...&redirect=...`.
- [ ] `oauth/callback.ts` — handler magic-link callback z Supabase Auth, wymiana sesji na JWT.
- [ ] `oauth/token.ts` — wymiana code → access_token (Supabase JWT z dodanymi claims).
- [ ] Helper `auth.ts` — middleware sprawdzający Bearer token w `Authorization` header dla write tools.
- [ ] Test E2E: pełny flow z `npx @modelcontextprotocol/inspector` z `--auth oauth`.

### Faza 2 — Read tools (3-4 dni)

#### Wspólna infrastruktura

- [ ] `lib/supabase.ts` — singleton Supabase admin client z service_role.
- [ ] `lib/affiliate.ts` — helper `buildAffiliateUrl({eventId, source, section, listingId, client})` zwracający format `/api/redirect?...`.
- [ ] `lib/format.ts` — formatery dat, cen, distance.
- [ ] `lib/errors.ts` — custom error classes z mapowaniem na MCP error codes (-32600 do -32603).
- [ ] `types/event.ts`, `types/listing.ts` etc. — TypeScript typy generowane przez `supabase gen types typescript`.
- [ ] `lib/cache.ts` — wrapper na Supabase Edge Function cache headers.
- [ ] `lib/client_detection.ts` — wnioskowanie nazwy klienta z User-Agent (Claude/ChatGPT/Cursor/unknown) dla `section=mcp:{client}`.

#### Implementacja read narzędzi

Per tool: schema (Zod), handler, formatter response, testy unit (Deno test), test integracyjny.

- [ ] `tools/search_events.ts` — sekcja 4.1.
- [ ] `tools/get_event.ts` — sekcja 4.2.
- [ ] `tools/find_cheapest_ticket.ts` — sekcja 4.3.
- [ ] `tools/search_by_artist.ts` — sekcja 4.4.
- [ ] `tools/events_near.ts` — sekcja 4.5.
- [ ] `tools/recommend_similar.ts` — sekcja 4.6.
- [ ] Rejestracja wszystkich tools w `mcp/index.ts` z annotations (`readOnlyHint=true`, `openWorldHint=true`).

#### Wymagania per tool

- [ ] Description ~150-300 słów, EN.
- [ ] Wszystkie inputy walidowane przez Zod.
- [ ] Wszystkie response zawierają `affiliate_url` z `section=mcp:{client}` i `permalink`.
- [ ] Error path: brak wyników → friendly message, nie error.
- [ ] DB error → przemielony przez `errors.ts` na MCP error.
- [ ] Logging entry/exit point z `console.log` w formacie strukturalnym JSON (Supabase Logs auto-parse).

### Faza 3 — Write tools (2-3 dni)

- [ ] `tools/track_price.ts` — sekcja 4.7.
- [ ] `tools/follow_artist.ts` — sekcja 4.8.
- [ ] `tools/subscribe_newsletter.ts` — sekcja 4.9.
- [ ] Confirmation email flow:
  - [ ] Edge function `send-confirmation` (osobna, używa Resend API lub Supabase SMTP).
  - [ ] Template HTML z brandem StageIn.
  - [ ] Magic-link confirmation URL (token z 24h TTL).
- [ ] Testy: auth required, idempotency, error paths.
- [ ] E2E test pełnego flow: OAuth → write tool call → DB update → confirmation email.

### Faza 4 — Hardening (1-2 dni)

- [ ] `lib/ratelimit.ts` — Postgres-based, sliding window, 60 req/min per IP, 600 req/h per authenticated user.
- [ ] Cache headers per tool (TTL z sekcji 3.5).
- [ ] Custom error responses w MCP format.
- [ ] Performance test: skrypt `scripts/bench.ts` puszczający 100 concurrent requests, raportuje p50/p95/p99.
- [ ] E2E smoke test: `scripts/e2e.ts` wywołujący każdy tool.
- [ ] Manual test każdego toola w:
  - [ ] Claude Desktop (custom connector URL).
  - [ ] Cursor (config przez Settings).
  - [ ] ChatGPT developer mode (Settings → Connectors → custom).
- [ ] OAuth flow test w 3 klientach (każdy ma swój flavor DCR).

### Faza 5 — Branding i dokumentacja (2 dni)

- [ ] Logo SVG (1024x1024 + 512x512 + 128x128) — wariant istniejącego StageIn brand z dopiskiem "MCP".
- [ ] Favicon (32x32, 64x64).
- [ ] 6-8 screenshotów workflow (Claude Desktop):
  1. Search dla "koncerty rockowe Warszawa grudzień".
  2. Get event details dla wybranego koncertu.
  3. Find cheapest ticket — porównanie ofert.
  4. Search by artist — Sanah/Daria Zawiałow przykład.
  5. Events near + lat/lng z Krakowa.
  6. Recommend similar po wybraniu koncertu.
  7. Track price (z auth flow).
  8. Follow artist (z auth flow).
- [ ] `README.md`: opis serwera, lista narzędzi z przykładami, instrukcja podłączenia, FAQ, link do privacy.
- [ ] `docs/PRIVACY.md` lub update `stagein.pl/privacy` z sekcją MCP Server.
- [ ] `docs/TOOLS.md` — pełna referencja narzędzi (schema + przykłady).
- [ ] `docs/AUTH.md` — opis OAuth flow dla deweloperów.
- [ ] Strona `stagein.pl/mcp` z setup instructions dla użytkowników.
- [ ] Update `stagein.pl/llms.txt` z linkiem do MCP server.
- [ ] **Demo account dla OpenAI submission:** stworzyć `mcp-demo@stagein.pl` z hasłem (NIE magic-link) i sample data dla review team.
- [ ] Krótki post w blogu Harbor LEGAL / na LinkedIn ogłaszający uruchomienie.

### Faza 6 — Submission (1 dzień + review)

#### Smithery (instant, no review)

- [ ] `smithery auth login`.
- [ ] `smithery mcp publish "https://mcp.stagein.pl" -n stagein/stagein`.
- [ ] Weryfikacja listingu na smithery.ai/server/stagein/stagein.
- [ ] Dodanie metadata: tagi, kategoria (`Travel & Events`), description.

#### Oficjalny MCP Registry

- [ ] Fork `github.com/modelcontextprotocol/servers`.
- [ ] Dodanie wpisu w `community/` lub odpowiedniej kategorii.
- [ ] PR z: nazwa, URL, autor, kategorie, tagi, opis, link do README.

#### Glama

- [ ] Auto-indexuje publiczne repo. Po 7 dniach sprawdzić listing na glama.ai.

#### Anthropic Connectors Directory

- [ ] Wypełnić "Remote MCP directory submission form" z claude.com/docs/connectors/building/submission.
  - Server basics, connection (auth=oauth, transport=streamable HTTP, capabilities=read+write).
  - Allowed link URIs: 7 partnerów + stagein.pl.
  - Data & compliance, branding, dokumentacja.
- [ ] Wait for review (1-2 tyg).

#### OpenAI ChatGPT App Directory

- [ ] Identity verification (business) w OpenAI Developer Platform.
- [ ] Test w Developer Mode w ChatGPT.
- [ ] Submission z annotations + screenshots + identity proof + demo account credentials.
- [ ] Wait for review (~2-4 tyg).

---

## 9. Pre-launch checklist

Przed naciśnięciem "publish" na każdej platformie:

- [ ] Wszystkie 6 narzędzi przechodzą E2E testy w 3 klientach (Claude, Cursor, ChatGPT).
- [ ] Performance: p95 search < 300ms, p95 get_event < 200ms.
- [ ] Rate limiting działa (test ręczny 100 req w minutę z jednego IP).
- [ ] Privacy policy live na stagein.pl/privacy z sekcją MCP.
- [ ] README live w repo z aktualnymi screenshotami.
- [ ] Strona stagein.pl/mcp z instrukcjami konfiguracji dostępna.
- [ ] Logo i favicon dostępne pod stałymi URL.
- [ ] llms.txt zaktualizowany.
- [ ] Affiliate URL tracking weryfikowany — kliknięcie z czata Claude → wpis w `affiliate_clicks` z `source='mcp'`.
- [ ] Monitoring: Cloudflare Analytics dashboard dostępny, alerty na 5xx > 1%/godz.
- [ ] Backup plan: rollback worker wersji w 1 komendzie w razie problemu.
- [ ] Comms plan: post LinkedIn/blog/email do listy gotowy do publikacji w dniu listingu.

---

## 10. Otwarte pytania (rozstrzygnięte)

| # | Pytanie | Decyzja |
|---|---|---|
| 1 | Repo: standalone `stagein-mcp` czy sub-folder w `stagein`? | **Standalone** |
| 2 | DB access: `service_role` z hardcoded WHERE czy `anon` z RLS policies? | **service_role** |
| 3 | Domena: `mcp.stagein.pl` czy `api.stagein.pl/mcp`? | **mcp.stagein.pl** |
| 4 | Logo: dedicated MCP wariant czy istniejący StageIn brand? | **Wariant z "MCP" badge** (do zaprojektowania w fazie 5) |
| 5 | Auth w v1 czy v2? | **v1** — OAuth 2.1 bridge + Supabase Auth magic-link |
| 6 | Click tracking endpoint? | **Istnieje:** `/api/redirect?eventId=&source=&section=&listingId=`. Tagowanie MCP przez `section=mcp:{client}` |
| 7 | Hosting: CF Workers vs Supabase Edge? | **Supabase Edge Function** (zmiana z CF — brak potrzeby trzeciego providera) |
| 8 | Sentry vs CF/Supabase Logs? | **Supabase Logs only w v1** |
| 9 | Tool descriptions: tylko EN czy bilingual? | **EN only** (lepsze tool selection AI) |
| 10 | View `v_events_full` czy zostawiamy JOINs? | **Decyzja po pomiarach perf w fazie 1** |
| 11 | `pg_trgm` od razu? | **Tak** (już dostępne, lepsze matche dla `search_by_artist`) |

---

## 11. Roadmapa post-launch

### v2 — Write tools + auth (po 4-6 tygodniach od v1)
- Magic-link auth flow (email → JWT z 24h TTL).
- `track_price` — INSERT do `price_alerts`, email notification.
- `follow_artist` — INSERT do `artist_follows`.
- `subscribe_newsletter` — INSERT do `newsletter_subscribers` z double opt-in.
- Submission do OpenAI Apps Directory z auth (wymaga demo account).

### v3 — Semantic search (3-4 miesiące od v1)
- Enable `pgvector` extension.
- Embedding pipeline: OpenAI `text-embedding-3-small` lub Voyage AI.
- Backfill embeddings dla wszystkich 4583 events.
- Cron przez `pg_cron` dla nowych eventów.
- Tool `search_semantic` — query w stylu "coś klimatycznego na walentynki w Krakowie".
- Reranking hybrid: BM25 (FTS) + cosine similarity.

### v4 — MCP Apps / Apps SDK widgets (6+ miesięcy)
- Embedded UI w Claude i ChatGPT — event card, listing comparison, map widget.
- Wymaga MCP UI standard implementation.
- Resubmission jako "Interactive" connector w Anthropic Directory.
- React components renderowane w iframe.

### v5 — Agentic Commerce
- Stripe Connect integration (bazując na designu z AleBilet).
- OpenAI Agentic Commerce Protocol.
- Instant checkout w ChatGPT bez wychodzenia.
- Rev share z partnerami (warunek: oddzielne agreementy z TM/AleBilet/eBilet).

### v6 — Multi-language
- Tool descriptions w EN, DE, FR, IT.
- Auto-translated event descriptions (cron).
- Rozszerzenie zasięgu na zagranicznych userów AI.

---

## 12. Ryzyka i mitygacje

| Ryzyko | Impact | Prawd. | Mitygacja |
|---|---|---|---|
| Niska adopcja MCP w pierwszych 3 miesiącach | Średni — strata na wartości projektu, ale tani eksperyment | Wysokie | Mierzymy tool calls/dzień, jeśli < 100/d po 3 mc rozważamy pivot na v3 z UI |
| Anthropic odrzuca submission (np. policy) | Niski — Smithery + MCP registry jako fallback | Niskie | Privacy policy + jasne use cases zmniejszają ryzyko |
| OpenAI klasyfikuje bilety jako "digital products" | Wysoki — blokada w ChatGPT Apps | Średnie | Argument: external checkout, agregator nie sprzedawca. Zachowanie dowodu w polityce |
| Performance regression przy growth ruchu | Średni | Niskie (CF skalujący) | Monitoring + p95 alerts + caching layer |
| Affiliate partner zmienia URL strukture | Średni — zwracane URL przestają działać | Średnie | Endpoint `/go/[id]` jako abstrakcja — zmiany tylko po stronie StageIn |
| Hashlock w `events.fts` przy specyficznych charakterach polskich | Niski | Niskie | Test z polskimi znakami w fazie 2, użycie `unaccent` extension jeśli problem |
| Konflikty w `mood_tags` między eventami (zbyt szerokie matche) | Niski — jakość recommend_similar | Średnie | Dodanie wagi po `category` i `event_date` proximity |
| Spam/abuse — bot scrapuje przez MCP | Niski | Średnie | Rate limit + ewentualnie auth wcześniej niż planowano |
| Koszt CF Workers przy skali | Niski | Niskie | Free tier do 100k req/d, paid to $5/mc. Realny koszt prawie zero |

---

## Załączniki (do produkcji w fazie 0-1)

- A. ER diagram bazy z zaznaczeniem tabel używanych przez MCP.
- B. Sekwencja diagramu — flow użycia narzędzia (AI client → MCP → DB → response).
- C. Tabela mapowania tool name → DB query (cheat sheet dla implementacji).
- D. Wzór privacy policy (sekcja "MCP Server").

---

**Koniec dokumentu — v0.1 draft**

Po akceptacji założeń i decyzji na otwarte pytania (sekcja 10), kolejnym krokiem jest faza 0: założenie repo i przygotowanie SQL migrations.
