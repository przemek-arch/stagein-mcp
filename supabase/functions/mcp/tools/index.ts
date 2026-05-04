import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchEvents } from "./search_events.ts";
import { registerGetEvent } from "./get_event.ts";
import { registerFindCheapestTicket } from "./find_cheapest_ticket.ts";
import { registerSearchByArtist } from "./search_by_artist.ts";
import { registerEventsNear } from "./events_near.ts";
import { registerRecommendSimilar } from "./recommend_similar.ts";
import { registerTrackPrice } from "./track_price.ts";

export function registerTools(mcp: McpServer) {
  registerSearchEvents(mcp);
  registerGetEvent(mcp);
  registerFindCheapestTicket(mcp);
  registerSearchByArtist(mcp);
  registerEventsNear(mcp);
  registerRecommendSimilar(mcp);
  registerTrackPrice(mcp);
  // Phase 2B-1 adds (next commits in same PR after auth context validation):
  //   registerFollowArtist, registerSubscribeNewsletter
}
