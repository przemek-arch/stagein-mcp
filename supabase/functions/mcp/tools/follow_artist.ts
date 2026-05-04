import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { admin } from "../lib/supabase.ts";
import { getUserEmail } from "../lib/user.ts";
import { requireAuthContext } from "../lib/auth_context.ts";

const InputSchema = z.object({
  artist_id: z.string().uuid().describe("Artist UUID to follow"),
});

type Input = z.infer<typeof InputSchema>;

interface ArtistRow {
  id: string;
  name: string;
}

interface ExistingFollow {
  id: string;
}

export function registerFollowArtist(mcp: McpServer) {
  mcp.tool(
    "follow_artist",
    "Follow an artist on StageIn. The user will receive email notifications when this artist announces new events.",
    InputSchema.shape,
    async (input: Input, _extra: unknown) => {
      const auth = requireAuthContext();
      const email = await getUserEmail(auth.user_id);
      if (!email) throw new Error("User email not found");

      const { data: artistRaw, error: artErr } = await admin()
        .from("artists")
        .select("id, name")
        .eq("id", input.artist_id)
        .maybeSingle();
      if (artErr) throw new Error(`Database error: ${artErr.message}`);
      if (!artistRaw) throw new Error(`Artist not found: ${input.artist_id}`);
      const artist = artistRaw as unknown as ArtistRow;

      const { data: existingRaw } = await admin()
        .from("artist_follows")
        .select("id")
        .eq("email", email)
        .eq("artist_id", input.artist_id)
        .eq("is_active", true)
        .maybeSingle();
      const existing = existingRaw as unknown as ExistingFollow | null;

      if (existing) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              message: `You're already following ${artist.name}.`,
              resource_id: existing.id,
            }),
          }],
        };
      }

      const { data: insertedRaw, error } = await admin()
        .from("artist_follows")
        .insert({ email, artist_id: input.artist_id })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to follow artist: ${error.message}`);
      const inserted = insertedRaw as unknown as { id: string };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            message: `Now following ${artist.name}. You'll be notified at ${email} when new events are announced.`,
            resource_id: inserted.id,
          }),
        }],
      };
    }
  );
}
