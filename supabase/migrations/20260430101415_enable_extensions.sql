-- Migration: enable extensions required for MCP server
-- Phase 1A — required for events_near (geo distance), search_by_artist (trigram fuzzy match)

-- Geographic distance calculations (events_near tool)
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- Trigram-based fuzzy text matching (search_by_artist tool)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Job scheduler for periodic cleanup (mcp_rate_limit, mcp_oauth_codes)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Verify
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'cube') THEN
    RAISE EXCEPTION 'cube extension not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'earthdistance') THEN
    RAISE EXCEPTION 'earthdistance extension not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'pg_trgm extension not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron extension not installed';
  END IF;
END $$;
