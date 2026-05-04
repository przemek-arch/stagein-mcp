import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchEvents } from "./search_events.ts";

export function registerTools(mcp: McpServer) {
  registerSearchEvents(mcp);
  // Phase 2A-2 adds: registerGetEvent, registerFindCheapestTicket
  // Phase 2A-3 adds: registerSearchByArtist, registerEventsNear
  // Phase 2A-4 adds: registerRecommendSimilar
  // Phase 2B-1 adds: registerTrackPrice, registerFollowArtist, registerSubscribeNewsletter
}
