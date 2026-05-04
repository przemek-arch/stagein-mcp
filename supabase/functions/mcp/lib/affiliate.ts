const BASE = "https://stagein.pl";

export function permalink(slug: string | null): string | null {
  if (!slug) return null;
  return `${BASE}/event/${slug}`;
}

export function affiliateUrl(params: {
  eventId: string;
  source: string;
  section: string;
  listingId?: string;
}): string {
  const sp = new URLSearchParams({
    eventId: params.eventId,
    source: params.source,
    section: params.section,
  });
  if (params.listingId) sp.set("listingId", params.listingId);
  return `${BASE}/api/redirect?${sp.toString()}`;
}

/**
 * Derives 'section' attribution string from MCP client name.
 * Used to tag affiliate clicks by client (Claude/ChatGPT/Cursor/etc.).
 * The OAuth client_name set during DCR flows through to JWT.
 */
export function clientSection(clientName: string | undefined): string {
  if (!clientName) return "mcp:unknown";
  const lower = clientName.toLowerCase();
  if (lower.includes("claude")) return "mcp:claude";
  if (lower.includes("chatgpt") || lower.includes("openai")) return "mcp:chatgpt";
  if (lower.includes("cursor")) return "mcp:cursor";
  if (lower.includes("inspector")) return "mcp:inspector";
  return `mcp:${lower.replace(/[^a-z0-9]+/g, "_").slice(0, 20)}`;
}
