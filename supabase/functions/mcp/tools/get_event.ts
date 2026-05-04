import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { availableListings } from "../lib/queries.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

interface EventDetailRow {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  ai_description: string | null;
  event_date: string;
  event_time: string | null;
  price_min: number | null;
  price_max: number | null;
  category: string | null;
  subcategory: string | null;
  mood_tags: string[] | null;
  image_url: string | null;
  slug: string | null;
  sold_percent: number | null;
  is_hot: boolean | null;
  lineup: string[] | null;
  status: string;
  venue: {
    id: string;
    name: string;
    city: string;
    region: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    venue_type: string | null;
  } | null;
  artist: {
    id: string;
    name: string;
    spotify_genres: string[] | null;
    spotify_image_url: string | null;
    spotify_followers: number | null;
    spotify_popularity: number | null;
    bio_pl: string | null;
    youtube_video_id: string | null;
  } | null;
}

interface ListingRow {
  id: string;
  source: string;
  price_min: number | null;
  price_max: number | null;
  offers_count: number | null;
  category: string | null;
  subcategory: string | null;
  sale_type: string | null;
  currency: string | null;
  ticket_url: string | null;
  fetched_at: string | null;
}

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Event UUID"),
});

type Input = z.infer<typeof InputSchema>;

export function registerGetEvent(mcp: McpServer) {
  mcp.tool(
    "get_event",
    "Get full details for a single StageIn event including all available ticket listings across sources, venue location, and artist info if applicable.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const start = Date.now();
      const section = clientSection(undefined);

      // Fetch event with venue and artist
      const { data: eventRaw, error: evtErr } = await admin()
        .from("events")
        .select(`
          id, title, subtitle, description, ai_description, event_date, event_time,
          price_min, price_max, category, subcategory, mood_tags, image_url,
          slug, sold_percent, is_hot, lineup, status,
          venue:venue_id (id, name, city, region, address, latitude, longitude, venue_type),
          artist:artist_id (id, name, spotify_genres, spotify_image_url, spotify_followers, spotify_popularity, bio_pl, youtube_video_id)
        `)
        .eq("id", input.event_id)
        .maybeSingle();

      if (evtErr) throw new Error(`Database error: ${evtErr.message}`);
      if (!eventRaw) throw new Error(`Event not found: ${input.event_id}`);
      const event = eventRaw as unknown as EventDetailRow;
      if (event.status !== "active") throw new Error(`Event not active: ${input.event_id}`);

      // Fetch all available listings, sorted by price ascending
      let listingsQb = admin()
        .from("listings")
        .select("id, source, price_min, price_max, offers_count, category, subcategory, sale_type, currency, ticket_url, fetched_at")
        .eq("event_id", input.event_id);
      listingsQb = availableListings(listingsQb);
      listingsQb = listingsQb.order("price_min", { ascending: true, nullsFirst: false });

      const { data: listings, error: lstErr } = await listingsQb;
      if (lstErr) throw new Error(`Database error: ${lstErr.message}`);

      const result = {
        id: event.id,
        title: event.title,
        subtitle: event.subtitle,
        description: event.description ?? event.ai_description,
        date: event.event_date,
        time: event.event_time,
        category: event.category,
        subcategory: event.subcategory,
        price_min: event.price_min,
        price_max: event.price_max,
        currency: "PLN",
        is_hot: event.is_hot,
        sold_percent: event.sold_percent,
        lineup: event.lineup,
        image_url: event.image_url,
        venue: event.venue,
        artist: event.artist,
        permalink: permalink(event.slug),
        affiliate_url: affiliateUrl({
          eventId: event.id,
          source: "alebilet",
          section,
        }),
        listings: ((listings ?? []) as unknown as ListingRow[]).map((l) => ({
          id: l.id,
          source: l.source,
          sale_type: l.sale_type,
          category: l.category,
          subcategory: l.subcategory,
          price_min: l.price_min,
          price_max: l.price_max,
          currency: l.currency,
          offers_count: l.offers_count,
          fetched_at: l.fetched_at,
          affiliate_url: affiliateUrl({
            eventId: event.id,
            source: l.source,
            section,
            listingId: l.id,
          }),
        })),
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            event: result,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
