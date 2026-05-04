import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { permalink, affiliateUrl } from "../lib/affiliate.ts";
import { requireAuthContext } from "../lib/auth_context.ts";

const InputSchema = z.object({
  artist_name: z.string().min(2).max(100).describe("Artist name (fuzzy match supported via trigram similarity)"),
  limit: z.number().int().min(1).max(20).default(10).describe("Max events to return per matching artist"),
});

type Input = z.infer<typeof InputSchema>;

interface ArtistEventJson {
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
  venue_id: string | null;
  venue_name: string | null;
  venue_city: string | null;
  venue_region: string | null;
}

interface ArtistMatchRow {
  artist_id: string;
  artist_name: string;
  artist_image_url: string | null;
  artist_followers: number | null;
  similarity_score: number;
  contains_substring: boolean;
  events: ArtistEventJson[];
}

export function registerSearchByArtist(mcp: McpServer) {
  mcp.tool(
    "search_by_artist",
    "Find upcoming StageIn events for a given artist. Uses trigram fuzzy matching so typos and partial names work (e.g., 'skolm' will find 'Skolim'). Returns events for ALL matching artists, ranked by exact substring match first, then by similarity score.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const start = Date.now();
      const auth = requireAuthContext();
      const sectionTag = auth.section;

      const { data, error } = await admin().rpc("search_artists_with_events_rpc", {
        query_text: input.artist_name,
        events_per_artist: input.limit,
        today_date: new Date().toISOString().slice(0, 10),
      });

      if (error) throw new Error(`Database error: ${error.message}`);

      const rows = (data ?? []) as unknown as ArtistMatchRow[];

      if (rows.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              matches: [],
              total_artists: 0,
              total_events: 0,
              message: `No artists found matching "${input.artist_name}".`,
              query_time_ms: Date.now() - start,
            }),
          }],
        };
      }

      const matches = rows.map((row) => ({
        artist: {
          id: row.artist_id,
          name: row.artist_name,
          image_url: row.artist_image_url,
          followers: row.artist_followers,
          similarity: Math.round(row.similarity_score * 1000) / 1000,
        },
        events: row.events.map((e) => ({
          id: e.id,
          title: e.title,
          date: e.event_date,
          venue: e.venue_id ? {
            id: e.venue_id,
            name: e.venue_name,
            city: e.venue_city,
            region: e.venue_region,
          } : null,
          price_min: e.price_min,
          currency: "PLN",
          is_hot: e.is_hot,
          permalink: permalink(e.slug),
          affiliate_url: affiliateUrl({
            eventId: e.id, source: "alebilet", section: sectionTag,
          }),
        })),
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
