// Returns an HTML Response with explicit, browser-friendly headers.
//
// Supabase Edge Runtime applies defensive defaults (text/plain content-type,
// default-src 'none'; sandbox CSP, nosniff) when a Response is constructed
// without explicit headers — the browser then renders our HTML as raw text.
// This helper ensures every user-facing OAuth page gets correct headers.
//
// CSP allows 'unsafe-inline' on style/script because the login form and
// callback shim contain inline <style> and inline <script> blocks.
// Stricter CSP (nonces/hashes) would be overengineering for these two
// transient pages. frame-ancestors + X-Frame-Options protect against
// clickjacking without breaking redirect-based OAuth.

const CSP = [
  "default-src 'self'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
