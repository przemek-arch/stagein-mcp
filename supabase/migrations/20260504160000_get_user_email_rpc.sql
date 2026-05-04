-- Migration: RPC for user email lookup by user_id
-- Phase 2B-1 fix — replaces unreliable auth.admin.getUserById() call
-- in lib/user.ts. Direct SQL access to auth.users via SECURITY DEFINER.
--
-- Why needed: auth.admin.getUserById() was silently failing in Edge Function
-- runtime (Deno + supabase-js@2.105.1), returning null without throwing.
-- Direct SQL is deterministic and works with the same service_role key.

CREATE OR REPLACE FUNCTION public.get_user_email_rpc(target_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT email FROM auth.users WHERE id = target_user_id LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_user_email_rpc IS
  'Look up auth.users email by user_id. SECURITY DEFINER bypasses RLS. Phase 2B-1 fix for getUserEmail() reliability.';
