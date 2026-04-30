-- Migration: OAuth 2.1 bridge tables for MCP server
-- Phase 1A — Dynamic Client Registration (RFC 7591) + authorization code flow with PKCE

-- Registered OAuth clients (one row per AI client connecting via DCR)
CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
  client_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_secret text NOT NULL,
  redirect_uris text[] NOT NULL,
  client_name text,
  client_uri text,
  logo_uri text,
  scope text,
  contacts text[],
  tos_uri text,
  policy_uri text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_last_used
  ON public.mcp_oauth_clients(last_used_at);

-- Short-lived authorization codes (10 min TTL)
CREATE TABLE IF NOT EXISTS public.mcp_oauth_codes (
  code text PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text,
  code_challenge_method text CHECK (code_challenge_method IN ('S256', 'plain')),
  scope text,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires
  ON public.mcp_oauth_codes(expires_at);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_user
  ON public.mcp_oauth_codes(user_id);

-- RLS: service_role only (MCP edge function manages all OAuth state)
ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_codes ENABLE ROW LEVEL SECURITY;

-- Cleanup function: remove expired codes hourly
CREATE OR REPLACE FUNCTION public.cleanup_mcp_oauth_codes()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.mcp_oauth_codes
  WHERE expires_at < now() - interval '1 hour';
$$;

SELECT cron.schedule(
  'cleanup-mcp-oauth-codes',
  '0 * * * *',
  $$SELECT public.cleanup_mcp_oauth_codes()$$
);

COMMENT ON TABLE public.mcp_oauth_clients IS 'Dynamic Client Registration storage for OAuth 2.1 (RFC 7591). One row per AI client (Claude, ChatGPT, Cursor, etc.).';
COMMENT ON TABLE public.mcp_oauth_codes IS 'Short-lived OAuth 2.1 authorization codes with PKCE. 10 min TTL, deleted hourly.';
