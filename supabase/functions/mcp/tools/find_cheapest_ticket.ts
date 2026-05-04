import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { availableListings } from "../lib/queries.ts";
import { affiliateUrl } from "../lib/affiliate.ts";
import { requireAuthContext } from "../lib/auth_context.ts";

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Event UUID"),
  sale_type: z.enum(["primary", "resale", "any"]).default("any")
    .describe("Filter by primary (official sale) or resale (secondary market). 'any' returns cheapest across both."),
});

type Input = z.infer<typeof InputSchema>;

export function registerFindCheapestTicket(mcp: McpServer) {
  mcp.tool(
    "find_cheapest_ticket",
    "Find the cheapest currently-available ticket for a given event across all StageIn ticket sources. Returns single best offer with direct purchase link, source vendor name, and price tier.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const start = Date.now();
      const auth = requireAuthContext();
      const section = auth.section;

      let qb = admin()
        .from("listings")
        .select("id, event_id, source, price_min, price_max, sale_type, category, subcategory, currency, offers_count")
        .eq("event_id", input.event_id);
      qb = availableListings(qb);

      if (input.sale_type !== "any") {
        qb = qb.eq("sale_type", input.sale_type);
      }
      qb = qb.not("price_min", "is", null)
              .order("price_min", { ascending: true })
              .limit(1);

      const { data, error } = await qb;
      if (error) throw new Error(`Database error: ${error.message}`);

      if (!data || data.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              found: false,
              message: "No available tickets for this event matching the criteria.",
              query_time_ms: Date.now() - start,
            }),
          }],
        };
      }

      const cheapest = data[0];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            found: true,
            listing: {
              id: cheapest.id,
              source: cheapest.source,
              sale_type: cheapest.sale_type,
              category: cheapest.category,
              subcategory: cheapest.subcategory,
              price: cheapest.price_min,
              currency: cheapest.currency ?? "PLN",
              offers_count: cheapest.offers_count,
              affiliate_url: affiliateUrl({
                eventId: cheapest.event_id,
                source: cheapest.source,
                section,
                listingId: cheapest.id,
              }),
            },
            query_time_ms: Date.now() - start,
          }, null, 2),
        }],
      };
    }
  );
}
