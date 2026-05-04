import { admin } from "./supabase.ts";

/**
 * Look up user email by user_id from auth.users.
 * Uses RPC get_user_email_rpc instead of auth.admin.getUserById() because
 * the latter silently fails in this Edge Function runtime (returns null
 * without throwing). Phase 2B-1 fix.
 */
export async function getUserEmail(user_id: string): Promise<string | null> {
  const { data, error } = await admin().rpc("get_user_email_rpc", {
    target_user_id: user_id,
  });
  if (error) {
    console.error("getUserEmail rpc error:", error);
    return null;
  }
  if (typeof data !== "string" || data.length === 0) return null;
  return data;
}
