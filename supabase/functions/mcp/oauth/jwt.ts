import { ISSUER } from "../lib/issuer.ts";

/**
 * MCP access token claims.
 * Uses HS256 signed by SUPABASE_JWT_SECRET (auto-injected env var).
 * Compatible with Supabase Auth so we COULD reuse Supabase verification later.
 */
export interface AccessTokenClaims {
  iss: string;          // issuer URL
  sub: string;          // user_id (Supabase auth.users.id)
  aud: string;          // resource server (same as iss for our setup)
  client_id: string;    // OAuth client that initiated the auth
  scope: string;        // space-separated scopes
  iat: number;          // issued at (unix seconds)
  exp: number;          // expiration (unix seconds)
}

const TOKEN_TTL_SECONDS = 3600; // 1 hour

export async function signAccessToken(params: {
  user_id: string;
  client_id: string;
  scope: string;
}): Promise<{ token: string; expires_in: number }> {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    iss: ISSUER,
    sub: params.user_id,
    aud: ISSUER,
    client_id: params.client_id,
    scope: params.scope,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const signatureB64 = base64urlEncode(new Uint8Array(signature));

  return {
    token: `${signingInput}.${signatureB64}`,
    expires_in: TOKEN_TTL_SECONDS,
  };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify signature
  const key = await getKey();
  const signature = base64urlDecode(signatureB64);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
  if (!valid) return null;

  // Parse and validate claims
  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  } catch {
    return null;
  }

  // Verify required claims
  if (claims.iss !== ISSUER) return null;
  if (claims.aud !== ISSUER) return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) return null;
  if (claims.iat > now + 60) return null; // small clock skew tolerance

  return claims;
}

let _key: CryptoKey | null = null;
async function getKey(): Promise<CryptoKey> {
  if (_key) return _key;
  const secret = Deno.env.get("MCP_JWT_SECRET");
  if (!secret) throw new Error("MCP_JWT_SECRET not available in env. Set it in Supabase Dashboard → Settings → Edge Functions → Secrets.");
  _key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return _key;
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
