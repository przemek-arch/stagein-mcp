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
    // Fragment-based response — auto-redirect via JS, with visible fallback button
    // if inline JS is blocked/delayed by browser extensions or privacy modes.
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Completing sign-in…</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #0a0a0a; color: #fff; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; padding: 2.5rem; max-width: 24rem; width: 100%; text-align: center; box-sizing: border-box; }
  h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 0.5rem; letter-spacing: -0.02em; }
  p { color: #888; font-size: 0.875rem; line-height: 1.6; margin: 0 0 1.5rem; }
  button { width: 100%; padding: 0.85rem; background: #C62B0A; color: #fff; border: none; font-size: 0.95rem; font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; }
  button:hover { background: #a62308; }
  .hidden { display: none; }
  .spinner { display: inline-block; width: 1rem; height: 1rem; border: 2px solid #444; border-top-color: #C62B0A; border-radius: 50%; animation: spin 1s linear infinite; vertical-align: middle; margin-right: 0.5rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="card" id="loading">
    <h1><span class="spinner"></span>Completing sign-in…</h1>
    <p>This should only take a moment.</p>
  </div>
  <div class="card hidden" id="manual">
    <h1>One more step</h1>
    <p>Auto-redirect didn't fire — click below to finish signing in.</p>
    <button type="button" id="continue-btn">Continue</button>
  </div>
  <script>
    (function () {
      function buildUrl() {
        var hashParams = new URLSearchParams(window.location.hash.slice(1));
        var stateToken = new URLSearchParams(window.location.search).get("state_token");
        if (stateToken) hashParams.set("state_token", stateToken);
        return window.location.pathname + "?" + hashParams.toString();
      }
      function showManual() {
        var loading = document.getElementById("loading");
        var manual = document.getElementById("manual");
        if (loading) loading.classList.add("hidden");
        if (manual) manual.classList.remove("hidden");
        var btn = document.getElementById("continue-btn");
        if (btn) {
          btn.onclick = function () { window.location.assign(buildUrl()); };
        }
      }
      try {
        var target = buildUrl();
        window.location.replace(target);
      } catch (e) {
        showManual();
        return;
      }
      // Fallback: if replace didn't navigate within 2s (blocked / paused),
      // surface the visible button so the user can finish manually.
      setTimeout(showManual, 2000);
    })();
  </script>
  <noscript>
    <div class="card">
      <h1>JavaScript required</h1>
      <p>Sign-in cannot complete without JavaScript. Enable it and reload this page.</p>
    </div>
  </noscript>
</body>
</html>`);
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
