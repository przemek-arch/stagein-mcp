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
