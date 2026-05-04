import { admin } from "./supabase.ts";

/**
 * In-memory cache for OAuth client_id → affiliate section slug.
 * Module-level Map persists across requests within a single Edge Function
 * instance. Client names are effectively immutable post-registration so
 * cache invalidation is not needed.
 */
const cache = new Map<string, string>();

const FALLBACK_SECTION = "mcp:unknown";

interface ClientRow {
  client_name: string | null;
}

/**
 * Convert a client_name string to a URL-safe affiliate section slug.
 * E.g., "Claude" → "mcp:claude", "ChatGPT App" → "mcp:chatgpt_app".
 */
function normalizeSection(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return slug ? `mcp:${slug}` : FALLBACK_SECTION;
}

/**
 * Look up affiliate section slug for OAuth client_id.
 * Returns "mcp:unknown" if client_id not found or has empty name.
 * Cached after first successful lookup.
 */
export async function getClientSection(client_id: string): Promise<string> {
  const cached = cache.get(client_id);
  if (cached) return cached;

  const { data, error } = await admin()
    .from("mcp_oauth_clients")
    .select("client_name")
    .eq("client_id", client_id)
    .maybeSingle();

  if (error) {
    console.error("getClientSection db error:", error);
    return FALLBACK_SECTION;
  }
  if (!data) return FALLBACK_SECTION;

  const row = data as unknown as ClientRow;
  const section = row.client_name ? normalizeSection(row.client_name) : FALLBACK_SECTION;
  cache.set(client_id, section);
  return section;
}
