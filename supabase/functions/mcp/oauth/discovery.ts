import type { Context } from "hono";
import {
  AUTHORIZATION_ENDPOINT,
  ISSUER,
  REGISTRATION_ENDPOINT,
  TOKEN_ENDPOINT,
} from "../lib/issuer.ts";

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 * Cached for 1h client-side per spec recommendation.
 */
export function authorizationServerMetadata(c: Context) {
  return c.json({
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    registration_endpoint: REGISTRATION_ENDPOINT,
    scopes_supported: ["mcp.read", "mcp.write"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://stagein.pl/mcp",
  }, 200, { "Cache-Control": "public, max-age=3600" });
}

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 * Tells MCP clients which authorization servers can issue valid tokens for this resource.
 * Required by MCP Authorization spec (2025-06-18).
 */
export function protectedResourceMetadata(c: Context) {
  return c.json({
    resource: ISSUER,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://stagein.pl/mcp",
    resource_signing_alg_values_supported: ["HS256"],
  }, 200, { "Cache-Control": "public, max-age=3600" });
}
