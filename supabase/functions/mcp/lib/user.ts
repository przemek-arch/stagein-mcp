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
