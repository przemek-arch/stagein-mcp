-- Migration: server-side state storage for OAuth authorize flow
-- Phase 1C-2 — bridges the email roundtrip in magic-link auth

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
