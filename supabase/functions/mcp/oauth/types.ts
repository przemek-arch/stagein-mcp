import { z } from "zod";

// RFC 7591 — Dynamic Client Registration request
export const ClientRegistrationRequest = z.object({
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string().email()).max(5).optional(),
  tos_uri: z.string().url().optional(),
  policy_uri: z.string().url().optional(),
  // RFC 7591 §2: client may declare any grant_types/response_types it can use.
  // We accept any array of strings here — the actual server-side enforcement
  // happens at token endpoint (only authorization_code is supported) and the
  // DCR response always echoes back ["authorization_code"] / ["code"] to signal
  // what we actually support. Strict literal validation rejected real-world
  // clients (Smithery DCR sent ["authorization_code", "refresh_token"]).
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.enum(["client_secret_post", "none"]).optional(),
});

export type ClientRegistrationRequest = z.infer<typeof ClientRegistrationRequest>;

// RFC 7591 — Dynamic Client Registration response
export interface ClientRegistrationResponse {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  grant_types: ["authorization_code"];
  response_types: ["code"];
  token_endpoint_auth_method: "client_secret_post";
}

// RFC 6749 — OAuth error response (used in all OAuth endpoints)
export interface OAuthError {
  error: string;
  error_description?: string;
  error_uri?: string;
}
