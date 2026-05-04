import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { permalink, affiliateUrl, clientSection } from "../lib/affiliate.ts";

const InputSchema = z.object({
  latitude: z.number().min(-90).max(90).describe("Search center latitude in decimal degrees"),
  longitude: z.number().min(-180).max(180).describe("Search center longitude in decimal degrees"),
  radius_km: z.number().positive().max(500).default(25).describe("Search radius in kilometers (max 500)"),
  limit: z.number().int().min(1).max(50).default(20),
});

type Input = z.infer<typeof InputSchema>;

interface EventsNearRpcRow {
  event_id: string;
  title: string;
  event_date: string;
  category: string | null;
  price_min: number | null;
  slug: string | null;
  venue_id: string;
  venue_name: string;
  venue_city: string;
  latitude: number;
  longitude: number;
  distance_m: number;
}

export function registerEventsNear(mcp: McpServer) {
  mcp.tool(
    "events_near",
    "Find upcoming StageIn events at venues near a given lat/lng coordinate. Note: only ~13% of StageIn venues have geocoded coordinates, so results are best in major Polish cities (Warszawa, Kraków, Wrocław, Poznań, Gdańsk).",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const start = Date.now();
      const section = clientSection(undefined);
      const today = new Date().toISOString().slice(0, 10);

      // Use earthdistance ll_to_earth for radius search via raw SQL
      // (Supabase JS doesn't support GIST <@ operator directly)
      const radiusMeters = input.radius_km * 1000;

      const { data, error } = await admin().rpc("events_near_rpc", {
        center_lat: input.latitude,
        center_lng: input.longitude,
        radius_m: radiusMeters,
        result_limit: input.limit,
        today_date: today,
      });

      if (error) throw new Error(`Database error: ${error.message}`);

      const rows = (data ?? []) as unknown as EventsNearRpcRow[];
      const results = rows.map((row) => ({
        id: row.event_id,
        title: row.title,
        date: row.event_date,
        category: row.category,
        price_min: row.price_min,
        currency: "PLN",
        venue: {
          id: row.venue_id,
          name: row.venue_name,
          city: row.venue_city,
          latitude: row.latitude,
          longitude: row.longitude,
        },
        distance_km: Math.round(row.distance_m / 100) / 10,
        permalink: permalink(row.slug),
        affiliate_url: affiliateUrl({
          eventId: row.event_id, source: "alebilet", section,
        }),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results,
            total: results.length,
            search_radius_km: input.radius_km,
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
