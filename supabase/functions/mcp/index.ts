// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";

import { SERVER_NAME, SERVER_TITLE, VERSION } from "./lib/version.ts";
import { admin } from "./lib/supabase.ts";

// Supabase Edge Runtime forwards full path including function name to the handler.
// Request to /functions/v1/mcp/health arrives as /mcp/health — basePath strips the /mcp prefix
// so route definitions can stay clean.
const app = new Hono().basePath("/mcp");

// CORS for MCP clients (Claude.ai, ChatGPT, Cursor)
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  c.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// Health check — no DB call to keep it cheap
app.get("/health", (c) =>
  c.json({
    status: "ok",
    name: SERVER_NAME,
    version: VERSION,
    timestamp: new Date().toISOString(),
  })
);

// Health check with DB reachability — heavier, for monitoring
app.get("/health/deep", async (c) => {
  const start = Date.now();
  try {
    const { error } = await admin().from("events").select("id").limit(1).maybeSingle();
    const dbOk = !error;
    return c.json({
      status: dbOk ? "ok" : "degraded",
      name: SERVER_NAME,
      version: VERSION,
      db_reachable: dbOk,
      db_latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
    }, dbOk ? 200 : 503);
  } catch (e) {
    return c.json({
      status: "error",
      error: String(e),
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

// Server manifest — metadata for AI clients and submission directories
app.get("/manifest", (c) =>
  c.json({
    name: SERVER_NAME,
    title: SERVER_TITLE,
    version: VERSION,
    description: "MCP server for StageIn — search Polish concert and event tickets aggregated from 7 ticket vendors. Provides AI assistants with structured access to upcoming events, listings with prices, venues, and artists.",
    homepage: "https://stagein.pl",
    documentation: "https://stagein.pl/mcp",
    contact: "office@harbor.legal",
    privacy_policy: "https://stagein.pl/privacy",
    categories: ["travel", "entertainment", "events"],
    capabilities: {
      tools: { count: 0, status: "phase-1b-skeleton" },
      auth: { type: "none", oauth_planned: "phase-1c" },
    },
  })
);

// MCP server instance (tools registered in Phase 2)
const mcp = new McpServer({
  name: SERVER_NAME,
  version: VERSION,
});

// MCP protocol handler at root
app.all("/", async (c) => {
  const transport = new StreamableHTTPTransport();
  await mcp.connect(transport);
  return transport.handleRequest(c);
});

// Wrap fetch with structured access log for observability in Supabase Logs.
Deno.serve((req) => {
  const start = Date.now();
  const url = new URL(req.url);
  const response = app.fetch(req);
  return Promise.resolve(response).then((res) => {
    console.log(JSON.stringify({
      at: "request",
      method: req.method,
      path: url.pathname,
      status: res.status,
      duration_ms: Date.now() - start,
    }));
    return res;
  });
});
