/**
 * Verifies PKCE code_verifier against code_challenge per RFC 7636.
 * Only S256 method supported (plain is deprecated and disabled in our authorize flow).
 */
export async function verifyPkce(
  code_verifier: string,
  code_challenge: string,
  method: string,
): Promise<boolean> {
  if (method !== "S256") return false;

  // Verifier must be 43-128 chars, base64url alphabet
  if (!/^[A-Za-z0-9_\-.~]{43,128}$/.test(code_verifier)) return false;

  const encoder = new TextEncoder();
  const data = encoder.encode(code_verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const computed = base64urlEncode(new Uint8Array(hash));

  // Constant-time comparison
  return constantTimeEqual(computed, code_challenge);
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
