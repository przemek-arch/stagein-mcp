import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchEvents } from "./search_events.ts";
import { registerGetEvent } from "./get_event.ts";
import { registerFindCheapestTicket } from "./find_cheapest_ticket.ts";

export function registerTools(mcp: McpServer) {
  registerSearchEvents(mcp);
  registerGetEvent(mcp);
  registerFindCheapestTicket(mcp);
  // Phase 2A-3 adds: registerSearchByArtist, registerEventsNear
  // Phase 2A-4 adds: registerRecommendSimilar
  // Phase 2B-1 adds: registerTrackPrice, registerFollowArtist, registerSubscribeNewsletter
}
