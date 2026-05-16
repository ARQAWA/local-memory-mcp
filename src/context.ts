import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStdioIdentity } from "./services/git-identity.service.js";
import { AuthorizationError } from "./errors.js";
import type { SamplingService } from "./services/sampling.service.js";
import type { OrgId, TeamSlug, UserId } from "./types/branded.js";
import { OrgId as toOrgId, TeamSlug as toTeamSlug, UserId as toUserId } from "./types/branded.js";

/**
 * Per-request context extracted from JWT auth.
 * Available to all services/tools via getRequestContext().
 * In stdio mode, uses defaults from config or CLI args.
 */
export interface RequestContext {
  org_id: OrgId;
  team_slug?: TeamSlug | undefined;
  user_id: UserId;
  role: "admin" | "writer" | "reader";
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Per-session sampling context. Each MCP session has its own SamplingService
 * bound to its own MCP Server instance. This prevents cross-session contamination
 * in HTTP mode where multiple sessions share one MemoryService.
 */
export const samplingContext = new AsyncLocalStorage<SamplingService>();

/**
 * Per-session auth context. Bound when an MCP session is created so that tool
 * handlers always have access to the correct auth context, even if the MCP SDK's
 * internal async processing breaks the primary requestContext AsyncLocalStorage chain.
 */
export const sessionAuthContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current session's SamplingService, or undefined if none is set.
 * Services should gracefully degrade when sampling is unavailable.
 */
export function getSamplingService(): SamplingService | undefined {
  return samplingContext.getStore();
}

/**
 * Get the current request's auth context.
 * Returns undefined if called outside a request (e.g., during startup).
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Get the current request's auth context, with fallback defaults for stdio mode.
 * In HTTP mode, the context is always set by the request handler.
 * In stdio mode, falls back to local defaults.
 */
export function getRequestContextOrDefault(): RequestContext {
  const store = requestContext.getStore();
  if (store) return store;

  // Check session-bound auth context (set per MCP session in HTTP mode).
  // This ensures correct RBAC even if AsyncLocalStorage is lost through the
  // MCP SDK's internal async processing pipeline.
  const sessionCtx = sessionAuthContext.getStore();
  if (sessionCtx) return sessionCtx;

  const identity = resolveStdioIdentity();
  const roleEnv = process.env["ENGRAM_ROLE"];
  const validRoles = ["admin", "writer", "reader"] as const;
  const role = validRoles.includes(roleEnv as (typeof validRoles)[number])
    ? (roleEnv as (typeof validRoles)[number])
    : "admin";
  return {
    org_id: toOrgId(identity.org_id),
    team_slug: identity.team_slug ? toTeamSlug(identity.team_slug) : undefined,
    user_id: toUserId(identity.user_id),
    role,
  };
}

/**
 * Require that a request context exists (HTTP mode).
 * Throws if called outside of requestContext.run() — prevents accidental auth bypass.
 */
export function requireRequestContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new AuthorizationError("No request context available");
  }
  return ctx;
}
