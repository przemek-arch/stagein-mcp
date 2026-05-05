import type { Context } from "hono";
import { admin } from "../lib/supabase.ts";
import { ClientRegistrationRequest, type ClientRegistrationResponse } from "./types.ts";

/**
 * RFC 7591 — Dynamic Client Registration.
 * Public endpoint, no auth required (intentional — that's the whole point of DCR).
 * Rate limiting is the responsibility of the caller infrastructure (Phase 3 hardening).
 */
export async function registerClient(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      error: "invalid_request",
      error_description: "Request body must be valid JSON",
    }, 400);
  }

  const parsed = ClientRegistrationRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "invalid_client_metadata",
      error_description: parsed.error.issues[0]?.message ?? "Invalid client metadata",
    }, 400);
  }

  // Validate redirect_uris: must be HTTPS or localhost (RFC 8252 — Native Apps)
  for (const uri of parsed.data.redirect_uris) {
    const url = new URL(uri);
    const isHttps = url.protocol === "https:";
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!isHttps && !isLoopback) {
      return c.json({
        error: "invalid_redirect_uri",
        error_description: `redirect_uri must use HTTPS or be a loopback address: ${uri}`,
      }, 400);
    }
  }

  // Generate client credentials
  const clientSecret = generateClientSecret();
  const issuedAt = Math.floor(Date.now() / 1000);

  // Insert into mcp_oauth_clients
  const { data, error } = await admin().from("mcp_oauth_clients").insert({
    client_secret: clientSecret,
    client_name: parsed.data.client_name,
    redirect_uris: parsed.data.redirect_uris,
    client_uri: parsed.data.client_uri ?? null,
    logo_uri: parsed.data.logo_uri ?? null,
    scope: parsed.data.scope ?? "mcp.read mcp.write",
    contacts: parsed.data.contacts ?? null,
    tos_uri: parsed.data.tos_uri ?? null,
    policy_uri: parsed.data.policy_uri ?? null,
  }).select("client_id").single();

  if (error || !data) {
    console.error("[oauth/register] DB insert failed:", error);
    return c.json({
      error: "server_error",
      error_description: "Failed to register client",
    }, 500);
  }

  const response: ClientRegistrationResponse = {
    client_id: data.client_id,
    client_secret: clientSecret,
    client_id_issued_at: issuedAt,
    client_secret_expires_at: 0,  // 0 = never expires per RFC 7591 §3.2.1
    client_name: parsed.data.client_name,
    redirect_uris: parsed.data.redirect_uris,
    client_uri: parsed.data.client_uri,
    logo_uri: parsed.data.logo_uri,
    scope: parsed.data.scope ?? "mcp.read mcp.write",
    contacts: parsed.data.contacts,
    tos_uri: parsed.data.tos_uri,
    policy_uri: parsed.data.policy_uri,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };

  return c.json(response, 201);
}

/**
 * Generates a 32-byte cryptographically random client secret,
 * encoded as base64url (no padding).
 */
function generateClientSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
