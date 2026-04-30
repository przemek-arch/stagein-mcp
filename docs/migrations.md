# Migrations workflow

## Why we don't use `supabase db push --linked`

The production StageIn database (`zrirjplulfqmjgtdwspt`) has migration history predating this repo — 15 migrations applied between March-April 2026 from the StageIn frontend project, before stagein-mcp was split out.

Running `supabase db push --linked` from this repo fails on the pre-flight sync check (CLI requires 1:1 mapping between local files and remote `schema_migrations`).

## How we apply migrations instead

Phase 1A migrations were applied via Supabase MCP `apply_migration` tool, which bypasses CLI sync entirely. Each migration registers in `schema_migrations` with its name. This is a deliberate workflow choice.

Local `supabase/migrations/*.sql` files remain as the source of truth for SQL content (reviewable in PRs, replayable manually if needed).

## Adding new migrations

1. Write SQL in a new `supabase/migrations/<timestamp>_<name>.sql` file.
2. Apply via Supabase MCP `apply_migration` (do NOT use `supabase db push`).
3. Verify with explicit SELECT queries from production schema.
4. Commit the SQL file with descriptive message.

## Phase 1A applied migrations (production state)

| Version | Name | Notes |
|---|---|---|
| 20260430103813 | enable_extensions_for_mcp | cube, earthdistance, pg_trgm, pg_cron |
| 20260430103834 | indexes_for_mcp | 5 indexes (idx_events_artist, idx_events_mood_tags, idx_listings_event_avail, idx_venues_geo, idx_artists_name_trgm) |
| 20260430103952 | mcp_rate_limit_table | Table + RLS + cleanup_mcp_rate_limit() + cron job |
| 20260430104023 | mcp_oauth_tables | mcp_oauth_clients + mcp_oauth_codes (with FK to auth.users) + RLS + cleanup_mcp_oauth_codes() + cron job |
