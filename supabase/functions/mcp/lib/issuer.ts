// Single source of truth for the OAuth issuer URL.
// When custom domain mcp.stagein.pl is configured in Phase 1D,
// flip this to "https://mcp.stagein.pl" (no /functions/v1/mcp suffix).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const PROJECT_REF = SUPABASE_URL.replace("https://", "").split(".")[0];

export const ISSUER = `https://${PROJECT_REF}.supabase.co/functions/v1/mcp`;
export const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/authorize`;
export const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
export const REGISTRATION_ENDPOINT = `${ISSUER}/oauth/register`;
