import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { activeUpcomingEvents } from "../lib/queries.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  artist_name: z.string().min(2).max(100).describe("Artist name (fuzzy match supported via trigram similarity)"),
  limit: z.number().int().min(1).max(20).default(10).describe("Max events to return per matching artist"),
});

type Input = z.infer<typeof InputSchema>;

interface ArtistRow {
  id: string;
  name: string;
  spotify_image_url: string | null;
  spotify_followers: number | null;
}

interface ArtistEventRow {
  id: string;
  title: string;
  subtitle: string | null;
  event_date: string;
  event_time: string | null;
  price_min: number | null;
  price_max: number | null;
  category: string | null;
  slug: string | null;
  image_url: string | null;
  is_hot: boolean | null;
  venue: { id: string; name: string; city: string; region: string | null } | null;
}

export function registerSearchByArtist(mcp: McpServer) {
  mcp.tool(
    "search_by_artist",
    "Find upcoming StageIn events for a given artist. Uses trigram fuzzy matching so typos and partial names work. Returns events for ALL matching artists (e.g., 'Behemoth' might match 'Behemoth' the band exactly while 'queen' could match 'Queen' and 'Queens of the Stone Age').",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const start = Date.now();
      const section = clientSection(undefined);

      // Find matching artists via trigram similarity (idx_artists_name_trgm)
      const { data: artists, error: artErr } = await admin()
        .from("artists")
        .select("id, name, spotify_image_url, spotify_followers")
        .ilike("name", `%${input.artist_name}%`)
        .order("spotify_followers", { ascending: false, nullsFirst: false })
        .limit(5);

      if (artErr) throw new Error(`Database error: ${artErr.message}`);
      if (!artists || artists.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              matches: [],
              total: 0,
              message: `No artists found matching "${input.artist_name}".`,
              query_time_ms: Date.now() - start,
            }),
          }],
        };
      }

      // For each matching artist, fetch their upcoming events
      const artistRows = artists as unknown as ArtistRow[];
      const matches = await Promise.all(artistRows.map(async (artist) => {
        let qb = admin().from("events").select(`
          id, title, subtitle, event_date, event_time, price_min, price_max,
          category, slug, image_url, is_hot,
          venue:venue_id (id, name, city, region)
        `).eq("artist_id", artist.id);
        qb = activeUpcomingEvents(qb);
        qb = qb.order("event_date", { ascending: true }).limit(input.limit);

        const { data: events } = await qb;

        const eventRows = (events ?? []) as unknown as ArtistEventRow[];
        return {
          artist: {
            id: artist.id,
            name: artist.name,
            image_url: artist.spotify_image_url,
            followers: artist.spotify_followers,
          },
          events: eventRows.map((e) => ({
            id: e.id,
            title: e.title,
            date: e.event_date,
            venue: e.venue,
            price_min: e.price_min,
            currency: "PLN",
            is_hot: e.is_hot,
            permalink: permalink(e.slug),
            affiliate_url: affiliateUrl({
              eventId: e.id, source: "alebilet", section,
            }),
          })),
        };
      }));

      const totalEvents = matches.reduce((sum, m) => sum + m.events.length, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            matches,
            total_artists: matches.length,
            total_events: totalEvents,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
