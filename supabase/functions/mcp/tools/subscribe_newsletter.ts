import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { getUserEmail } from "../lib/user.ts";
import { requireAuthContext } from "../lib/auth_context.ts";

const InputSchema = z.object({
  city: z.string().optional().describe("Preferred city for event recommendations (e.g., 'Warszawa')"),
  preferences: z.array(z.string()).max(10).optional()
    .describe("List of category preferences (e.g., ['MUZYKA', 'STAND-UP'])"),
});

type Input = z.infer<typeof InputSchema>;

interface ExistingSubscriber {
  id: string;
  is_active: boolean;
  confirmed: boolean;
}

export function registerSubscribeNewsletter(mcp: McpServer) {
  mcp.tool(
    "subscribe_newsletter",
    "Subscribe to the StageIn weekly newsletter — curated event recommendations delivered every Friday. Optional: filter by city and category preferences.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const auth = requireAuthContext();
      const email = await getUserEmail(auth.user_id);
      if (!email) throw new Error("User email not found");

      const { data: existingRaw } = await admin()
        .from("newsletter_subscribers")
        .select("id, is_active, confirmed")
        .eq("email", email)
        .maybeSingle();
      const existing = existingRaw as unknown as ExistingSubscriber | null;

      if (existing && existing.is_active && existing.confirmed) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: "You're already subscribed to the StageIn newsletter.",
              resource_id: existing.id,
            }),
          }],
        };
      }

      if (existing) {
        const { data: updatedRaw, error } = await admin()
          .from("newsletter_subscribers")
          .update({
            is_active: true,
            city: input.city ?? null,
            preferences: input.preferences ?? [],
          })
          .eq("id", existing.id)
          .select("id")
          .single();
        if (error) throw new Error(`Failed to update subscription: ${error.message}`);
        const updated = updatedRaw as unknown as { id: string };

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: existing.confirmed
                ? "Subscription preferences updated."
                : "Subscription re-activated. Check your email to confirm.",
              resource_id: updated.id,
            }),
          }],
        };
      }

      const confirmation_token = crypto.randomUUID();
      const { data: insertedRaw, error } = await admin()
        .from("newsletter_subscribers")
        .insert({
          email,
          city: input.city ?? null,
          preferences: input.preferences ?? [],
          confirmation_token,
          confirmed: false,
          is_active: true,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to subscribe: ${error.message}`);
      const inserted = insertedRaw as unknown as { id: string };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            message: `Subscription created. Check your email at ${email} to confirm.`,
            resource_id: inserted.id,
          }),
        }],
      };
    }
  );
}
