import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Auth context propagated from Bearer middleware to MCP tool handlers
 * via AsyncLocalStorage. Each request enters a fresh context scope at
 * the MCP route handler in index.ts (authContext.run(...)) and tools
 * read it via getAuthContext().
 */
export interface AuthContext {
  user_id: string;
  client_id: string;
  scope: string;
  section: string;  // pre-computed affiliate section slug, e.g., "mcp:claude"
}

export const authContext = new AsyncLocalStorage<AuthContext>();

/**
 * Read auth context from AsyncLocalStorage. Returns undefined if not in
 * a request scope (e.g., called outside MCP tool handler).
 */
export function getAuthContext(): AuthContext | undefined {
  return authContext.getStore();
}

/**
 * Get auth context or throw. Use in write tools where auth is required.
 */
export function requireAuthContext(): AuthContext {
  const auth = authContext.getStore();
  if (!auth) {
    throw new Error("Authentication required: no auth context in request scope");
  }
  return auth;
}
