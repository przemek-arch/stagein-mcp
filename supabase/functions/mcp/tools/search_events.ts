import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { activeUpcomingEvents } from "../lib/queries.ts";
import { permalink, affiliateUrl } from "../lib/affiliate.ts";
import { requireAuthContext } from "../lib/auth_context.ts";

interface EventRow {
  id: string;
  title: string;
  subtitle: string | null;
  event_date: string;
  event_time: string | null;
  price_min: number | null;
  price_max: number | null;
  category: string | null;
  subcategory: string | null;
  slug: string | null;
  image_url: string | null;
  sold_percent: number | null;
  is_hot: boolean | null;
  venue: { id: string; name: string; city: string; region: string | null } | null;
  artist: { id: string; name: string; spotify_image_url: string | null } | null;
}

const InputSchema = z.object({
  query: z.string().optional().describe("Free-text search across event title, subtitle, lineup, venue name"),
  city: z.string().optional().describe("Filter by city name (Polish, exact match — e.g., 'Warszawa', 'Kraków')"),
  category: z.enum([
    "MUZYKA", "SCENA", "FESTIWAL", "INNE", "WYSTAWA", "SPORT", "STAND-UP", "KONCERT"
  ]).optional().describe("Event category filter"),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date YYYY-MM-DD, inclusive"),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date YYYY-MM-DD, inclusive"),
  price_max: z.number().positive().optional().describe("Maximum minimum-price (PLN) — events with cheaper tickets only"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max results to return (1-50, default 10)"),
});

type Input = z.infer<typeof InputSchema>;

export function registerSearchEvents(mcp: McpServer) {
  mcp.tool(
    "search_events",
    "Search StageIn for upcoming concerts, festivals, and events. Returns events filtered by free-text query, city, category, date range, and price ceiling. Results include direct purchase links via StageIn affiliate redirects.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const start = Date.now();
      const auth = requireAuthContext();
      const sectionTag = auth.section;

      let qb = admin().from("events").select(`
        id, title, subtitle, event_date, event_time, price_min, price_max,
        category, subcategory, slug, image_url, sold_percent, is_hot,
        venue:venue_id (id, name, city, region),
        artist:artist_id (id, name, spotify_image_url)
      `);

      qb = activeUpcomingEvents(qb);

      if (input.query) {
        // Use FTS for word-level matching, fallback to ilike for short queries
        if (input.query.length >= 3) {
          qb = qb.textSearch("fts", input.query.split(/\s+/).join(" & "));
        } else {
          qb = qb.ilike("title", `%${input.query}%`);
        }
      }
      if (input.city) {
        qb = qb.eq("venue.city", input.city);
      }
      if (input.category) {
        qb = qb.eq("category", input.category);
      }
      if (input.date_from) qb = qb.gte("event_date", input.date_from);
      if (input.date_to) qb = qb.lte("event_date", input.date_to);
      if (input.price_max !== undefined) qb = qb.lte("price_min", input.price_max);

      qb = qb.order("event_date", { ascending: true }).limit(input.limit);

      const { data, error } = await qb;
      if (error) throw new Error(`Database error: ${error.message}`);

      // Postgrest types nested relations as arrays even for 1-to-1 (it can't infer
      // from select() string alone). EventRow models actual runtime shape (single
      // object via venue_id FK). Cast is intentional and verified against schema.
      const rows = (data ?? []) as unknown as EventRow[];
      const results = rows.map((e) => ({
        id: e.id,
        title: e.title,
        subtitle: e.subtitle,
        date: e.event_date,
        time: e.event_time,
        category: e.category,
        subcategory: e.subcategory,
        price_min: e.price_min,
        price_max: e.price_max,
        currency: "PLN",
        is_hot: e.is_hot,
        sold_percent: e.sold_percent,
        venue: e.venue ? {
          name: e.venue.name,
          city: e.venue.city,
          region: e.venue.region,
        } : null,
        artist: e.artist ? {
          id: e.artist.id,
          name: e.artist.name,
          image_url: e.artist.spotify_image_url,
        } : null,
        image_url: e.image_url,
        permalink: permalink(e.slug),
        affiliate_url: affiliateUrl({
          eventId: e.id,
          source: "alebilet",
          section: sectionTag,
        }),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results,
            total: results.length,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
