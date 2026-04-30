-- Migration: rate limiting table for MCP server
-- Phase 1A — sliding window counter, 60 req/min anonymous, 600 req/h authenticated
-- Note: column named `window_start` (not `window`) because `window` is a reserved keyword in PostgreSQL.

CREATE TABLE IF NOT EXISTS public.mcp_rate_limit (
  ip text NOT NULL,
  window_start timestamp with time zone NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (ip, window_start)
);

CREATE INDEX IF NOT EXISTS idx_mcp_rate_limit_window
  ON public.mcp_rate_limit(window_start);

-- RLS: only service_role can read/write (MCP edge function uses service_role)
ALTER TABLE public.mcp_rate_limit ENABLE ROW LEVEL SECURITY;

-- No policies = service_role only access (anon and authenticated cannot touch this table)

-- Cleanup function: removes windows older than 1 hour
CREATE OR REPLACE FUNCTION public.cleanup_mcp_rate_limit()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.mcp_rate_limit WHERE window_start < now() - interval '1 hour';
$$;

-- Schedule cleanup every hour via pg_cron
-- pg_cron is already enabled in the project (used by other features)
SELECT cron.schedule(
  'cleanup-mcp-rate-limit',
  '0 * * * *',
  $$SELECT public.cleanup_mcp_rate_limit()$$
);

COMMENT ON TABLE public.mcp_rate_limit IS 'Sliding-window rate limit counter for MCP server. Cleaned up hourly by pg_cron.';
