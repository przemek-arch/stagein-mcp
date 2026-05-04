import type { Context } from "hono";
import { admin } from "../lib/supabase.ts";
import { consumeState } from "./state.ts";

/**
 * GET /oauth/callback?state_token=...&access_token=...&token_type=bearer&...
 * Receives the user back from Supabase Auth magic link.
 * Verifies session, generates authorization code, redirects to client.
 */
export async function callback(c: Context) {
  const url = new URL(c.req.url);
  const state_token = url.searchParams.get("state_token");

  // Supabase Auth puts tokens in the URL fragment (#access_token=...) by default,
  // but with emailRedirectTo it puts them in query for non-PKCE flow.
  // We rely on the access_token query param for server-side verification.
  const access_token = url.searchParams.get("access_token");

  if (!state_token) {
    return c.html("<h1>Invalid callback</h1><p>Missing state token.</p>", 400);
  }

  if (!access_token) {
    // Fragment-based response — show a small JS shim that re-issues the request with query params
    return c.html(`<!DOCTYPE html><html><body><script>
      const params = new URLSearchParams(window.location.hash.slice(1));
      const stateToken = new URLSearchParams(window.location.search).get("state_token");
      params.set("state_token", stateToken);
      window.location.replace(window.location.pathname + "?" + params.toString());
    </script><noscript>JavaScript required to complete sign-in.</noscript></body></html>`);
  }

  // Verify the access token belongs to a real Supabase user
  const { data: userData, error: userErr } = await admin().auth.getUser(access_token);
  if (userErr || !userData.user) {
    return c.html("<h1>Invalid session</h1><p>Sign-in failed. Please try again.</p>", 401);
  }

  // Consume state (single-use)
  const state = await consumeState(state_token);
  if (!state) {
    return c.html("<h1>Session expired</h1><p>The authorization flow expired or was already used.</p>", 400);
  }

  // Generate authorization code
  const code = generateAuthCode();
  const { error: codeErr } = await admin().from("mcp_oauth_codes").insert({
    code,
    client_id: state.client_id,
    user_id: userData.user.id,
    redirect_uri: state.redirect_uri,
    code_challenge: state.code_challenge,
    code_challenge_method: state.code_challenge_method,
    scope: state.scope,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (codeErr) {
    console.error("[oauth/callback] failed to store code:", codeErr);
    return c.html("<h1>Server error</h1><p>Please try again.</p>", 500);
  }

  // Build redirect URL with code and original client state
  const redirectUrl = new URL(state.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state.client_state) {
    redirectUrl.searchParams.set("state", state.client_state);
  }

  return c.redirect(redirectUrl.toString(), 302);
}

function generateAuthCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
