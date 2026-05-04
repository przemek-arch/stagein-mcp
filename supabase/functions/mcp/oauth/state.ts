import { admin } from "../lib/supabase.ts";

export interface AuthorizeState {
  state_token: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  scope: string | null;
  client_state: string | null;
}

export function generateStateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function storeState(state: AuthorizeState): Promise<void> {
  const { error } = await admin().from("mcp_oauth_authorize_state").insert({
    state_token: state.state_token,
    client_id: state.client_id,
    redirect_uri: state.redirect_uri,
    code_challenge: state.code_challenge,
    code_challenge_method: state.code_challenge_method,
    scope: state.scope,
    client_state: state.client_state,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) throw new Error(`Failed to store authorize state: ${error.message}`);
}

export async function consumeState(state_token: string): Promise<AuthorizeState | null> {
  const { data, error } = await admin()
    .from("mcp_oauth_authorize_state")
    .select("*")
    .eq("state_token", state_token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;

  // Single-use — delete after read
  await admin().from("mcp_oauth_authorize_state").delete().eq("state_token", state_token);

  return {
    state_token: data.state_token,
    client_id: data.client_id,
    redirect_uri: data.redirect_uri,
    code_challenge: data.code_challenge,
    code_challenge_method: data.code_challenge_method,
    scope: data.scope,
    client_state: data.client_state,
  };
}
