import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Seed event UUID — find events similar to this one"),
  limit: z.number().int().min(1).max(20).default(10),
});

type Input = z.infer<typeof InputSchema>;

interface SimilarRow {
  event_id: string;
  title: string;
  event_date: string;
  category: string | null;
  price_min: number | null;
  slug: string | null;
  venue_name: string | null;
  venue_city: string | null;
  artist_name: string | null;
  artist_image_url: string | null;
  similarity_score: number;
  similarity_reason: string;
}

export function registerRecommendSimilar(mcp: McpServer) {
  mcp.tool(
    "recommend_similar",
    "Recommend events similar to a seed event. Uses multi-signal scoring: same artist (highest), overlapping Spotify genres, same category + city, then same category. Useful for 'more like this' UX.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const start = Date.now();
      const sectionTag = clientSection(undefined);

      const { data, error } = await admin().rpc("recommend_similar_events_rpc", {
        seed_event_id: input.event_id,
        result_limit: input.limit,
        today_date: new Date().toISOString().slice(0, 10),
      });

      if (error) {
        if (error.message.includes("Seed event") && error.message.includes("not found")) {
          throw new Error(`Event not found: ${input.event_id}`);
        }
        throw new Error(`Database error: ${error.message}`);
      }

      const rows = (data ?? []) as unknown as SimilarRow[];

      const results = rows.map((row) => ({
        id: row.event_id,
        title: row.title,
        date: row.event_date,
        category: row.category,
        price_min: row.price_min,
        currency: "PLN",
        venue: row.venue_name ? { name: row.venue_name, city: row.venue_city } : null,
        artist: row.artist_name ? {
          name: row.artist_name,
          image_url: row.artist_image_url,
        } : null,
        similarity_score: row.similarity_score,
        similarity_reason: row.similarity_reason,
        permalink: permalink(row.slug),
        affiliate_url: affiliateUrl({
          eventId: row.event_id, source: "alebilet", section: sectionTag,
        }),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            seed_event_id: input.event_id,
            recommendations: results,
            total: results.length,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
