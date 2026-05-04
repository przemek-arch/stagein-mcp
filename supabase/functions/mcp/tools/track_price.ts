import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { getUserEmail } from "../lib/user.ts";
import { requireAuthContext } from "../lib/auth_context.ts";

const InputSchema = z.object({
  event_id: z.string().uuid().describe("Event UUID to track price for"),
});

type Input = z.infer<typeof InputSchema>;

interface CheapestListing {
  price_min: number;
  source: string;
  event_id: string;
}

interface EventRow {
  id: string;
  title: string;
  status: string;
  event_date: string;
}

interface ExistingAlert {
  id: string;
}

export function registerTrackPrice(mcp: McpServer) {
  mcp.tool(
    "track_price",
    "Subscribe to price drop alerts for a StageIn event. The user will be notified by email when the cheapest available ticket becomes cheaper than the current price.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const auth = requireAuthContext();
      const email = await getUserEmail(auth.user_id);
      if (!email) throw new Error("User email not found");

      // Verify event exists and is active
      const { data: evtRaw, error: evtErr } = await admin()
        .from("events")
        .select("id, title, status, event_date")
        .eq("id", input.event_id)
        .maybeSingle();
      if (evtErr) throw new Error(`Database error: ${evtErr.message}`);
      if (!evtRaw) throw new Error(`Event not found: ${input.event_id}`);
      const event = evtRaw as unknown as EventRow;
      if (event.status !== "active") throw new Error("Event is not active");

      // Get current cheapest listing
      const { data: cheapestRaw, error: priceErr } = await admin()
        .from("listings")
        .select("price_min, source, event_id")
        .eq("event_id", input.event_id)
        .eq("is_available", true)
        .not("price_min", "is", null)
        .order("price_min", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (priceErr) throw new Error(`Database error: ${priceErr.message}`);
      if (!cheapestRaw) throw new Error("No available tickets to track for this event");
      const cheapest = cheapestRaw as unknown as CheapestListing;

      // Check duplicate active alert
      const { data: existingRaw } = await admin()
        .from("price_alerts")
        .select("id")
        .eq("email", email)
        .eq("event_id", input.event_id)
        .eq("is_active", true)
        .maybeSingle();
      const existing = existingRaw as unknown as ExistingAlert | null;

      if (existing) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: `You're already tracking price for "${event.title}". No duplicate alert created.`,
              resource_id: existing.id,
            }),
          }],
        };
      }

      // Insert
      const { data: insertedRaw, error: insErr } = await admin()
        .from("price_alerts")
        .insert({
          email,
          event_id: input.event_id,
          price_at_alert: cheapest.price_min,
          source: cheapest.source,
        })
        .select("id")
        .single();
      if (insErr) throw new Error(`Failed to create price alert: ${insErr.message}`);
      const inserted = insertedRaw as unknown as { id: string };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            message: `Price alert created for "${event.title}". You'll be notified at ${email} when the price drops below ${cheapest.price_min} PLN.`,
            resource_id: inserted.id,
          }),
        }],
      };
    }
  );
}
