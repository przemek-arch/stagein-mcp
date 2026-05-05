// Single source of truth for the OAuth issuer URL.
//
// mcp.stagein.pl is a Vercel host-based rewrite that transparently proxies
// to the Supabase Edge Function endpoint:
//   https://zrirjplulfqmjgtdwspt.supabase.co/functions/v1/mcp
//
// Rewrite is configured in repo przemek-arch/stagein, vercel.json.
// To revert: change ISSUER back and redeploy. Vercel rewrite stays — harmless.

export const ISSUER = "https://mcp.stagein.pl";
export const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/authorize`;
export const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
export const REGISTRATION_ENDPOINT = `${ISSUER}/oauth/register`;
