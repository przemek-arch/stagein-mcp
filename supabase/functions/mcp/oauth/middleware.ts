import type { MiddlewareHandler } from "hono";
import { verifyAccessToken } from "./jwt.ts";

declare module "hono" {
  interface ContextVariableMap {
    auth: {
      user_id: string;
      client_id: string;
      scope: string;
    };
  }
}

/**
 * Hono middleware that enforces Bearer JWT on protected routes.
 * Returns 401 with WWW-Authenticate header per RFC 6750 if missing/invalid.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer realm="StageIn MCP", error="invalid_token"`,
    });
  }

  const token = authHeader.slice(7).trim();
  const claims = await verifyAccessToken(token);
  if (!claims) {
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer realm="StageIn MCP", error="invalid_token", error_description="Token is invalid or expired"`,
    });
  }

  c.set("auth", {
    user_id: claims.sub,
    client_id: claims.client_id,
    scope: claims.scope,
  });

  await next();
};
