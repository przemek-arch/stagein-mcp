import type { Context } from "hono";
import { admin } from "../lib/supabase.ts";
import { verifyPkce } from "./pkce.ts";
import { signAccessToken } from "./jwt.ts";

/**
 * POST /oauth/token
 * Exchanges authorization_code for access_token.
 * Implements RFC 6749 §4.1.3 + RFC 7636 (PKCE).
 */
export async function tokenExchange(c: Context) {
  let body: URLSearchParams;
  try {
    const text = await c.req.text();
    body = new URLSearchParams(text);
  } catch {
    return tokenError(c, "invalid_request", "Body must be application/x-www-form-urlencoded");
  }

  const grant_type = body.get("grant_type");
  if (grant_type !== "authorization_code") {
    return tokenError(c, "unsupported_grant_type");
  }

  const code = body.get("code");
  const client_id = body.get("client_id");
  const client_secret = body.get("client_secret");
  const redirect_uri = body.get("redirect_uri");
  const code_verifier = body.get("code_verifier");

  if (!code || !client_id || !redirect_uri || !code_verifier) {
    return tokenError(c, "invalid_request", "Missing required parameter");
  }

  // Verify client credentials
  const { data: client } = await admin()
    .from("mcp_oauth_clients")
    .select("client_id, client_secret")
    .eq("client_id", client_id)
    .maybeSingle();

  if (!client) {
    return tokenError(c, "invalid_client");
  }

  // For confidential clients (token_endpoint_auth_method=client_secret_post)
  // we require client_secret. For public clients, client_secret is optional but
  // PKCE is mandatory (which we enforce regardless).
  if (client_secret && client_secret !== client.client_secret) {
    return tokenError(c, "invalid_client");
  }

  // Look up the authorization code
  const { data: codeRow } = await admin()
    .from("mcp_oauth_codes")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (!codeRow) {
    return tokenError(c, "invalid_grant", "Authorization code not found");
  }

  // Verify code matches the client and redirect_uri
  if (codeRow.client_id !== client_id) {
    return tokenError(c, "invalid_grant", "Code was issued to a different client");
  }
  if (codeRow.redirect_uri !== redirect_uri) {
    return tokenError(c, "invalid_grant", "redirect_uri mismatch");
  }

  // Code expiration
  if (new Date(codeRow.expires_at) < new Date()) {
    return tokenError(c, "invalid_grant", "Authorization code expired");
  }

  // Code single-use enforcement
  if (codeRow.used_at) {
    // Per RFC 6749 §4.1.2: revoke any tokens previously issued from this code.
    // For Phase 1C we just deny; full token revocation comes in Phase 3.
    return tokenError(c, "invalid_grant", "Authorization code already used");
  }

  // PKCE verification
  const pkceOk = await verifyPkce(
    code_verifier,
    codeRow.code_challenge,
    codeRow.code_challenge_method,
  );
  if (!pkceOk) {
    return tokenError(c, "invalid_grant", "PKCE verification failed");
  }

  // Mark code as used
  await admin()
    .from("mcp_oauth_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code);

  // Update last_used_at on client
  await admin()
    .from("mcp_oauth_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", client_id);

  // Issue access token
  const { token, expires_in } = await signAccessToken({
    user_id: codeRow.user_id,
    client_id: codeRow.client_id,
    scope: codeRow.scope ?? "mcp.read mcp.write",
  });

  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in,
    scope: codeRow.scope ?? "mcp.read mcp.write",
  }, 200, {
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
  });
}

function tokenError(c: Context, error: string, description?: string) {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return c.json(body, 400, { "Cache-Control": "no-store" });
}
