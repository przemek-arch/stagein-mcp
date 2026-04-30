# StageIn MCP Server

[![CI](https://github.com/przemek-arch/stagein-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/przemek-arch/stagein-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)

Model Context Protocol server for [StageIn](https://stagein.pl) — a Polish concert and event ticket aggregator. Lets AI assistants (Claude, ChatGPT, Cursor) search, discover, and track tickets directly from chat.

**Production endpoint:** `https://mcp.stagein.pl`

## Tools

Six read tools (no auth) and three write tools (OAuth required):

- `search_events` — full-text + filter search
- `get_event` — full event details
- `find_cheapest_ticket` — cheapest available listing
- `search_by_artist` — events by artist
- `events_near` — events within radius of coordinates
- `recommend_similar` — similar events
- `track_price` *(auth)* — price alert
- `follow_artist` *(auth)* — artist follow
- `subscribe_newsletter` *(auth)* — newsletter signup

Full schemas: [`docs/TOOLS.md`](./docs/TOOLS.md).

## Quickstart

*Coming in Phase 5.* Setup instructions for Claude Desktop, Cursor, and ChatGPT will land here.

## Links

- [Implementation plan](./STAGEIN_MCP_IMPLEMENTATION_PLAN.md)
- [Privacy policy](./PRIVACY.md)
- [Auth flow for developers](./docs/AUTH.md)
- [MCP specification](https://modelcontextprotocol.io)

## License

MIT — see [LICENSE](./LICENSE).
