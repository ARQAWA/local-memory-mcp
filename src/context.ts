import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStdioIdentity, type RepositoryIdentity } from "./services/git-identity.service.js";
import { AuthorizationError, ValidationError } from "./errors.js";
import type { SamplingService } from "./services/sampling.service.js";
import type { UserId } from "./types/branded.js";
import { UserId as toUserId } from "./types/branded.js";

export interface RequestContext {
  repository: RepositoryIdentity;
  user_id: UserId;
  role: "admin" | "writer" | "reader";
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
export const samplingContext = new AsyncLocalStorage<SamplingService>();
export const sessionAuthContext = new AsyncLocalStorage<RequestContext>();

export function getSamplingService(): SamplingService | undefined {
  return samplingContext.getStore();
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function getRequestContextOrDefault(): RequestContext {
  const store = requestContext.getStore();
  if (store) return store;

  const sessionCtx = sessionAuthContext.getStore();
  if (sessionCtx) return sessionCtx;

  let identity: ReturnType<typeof resolveStdioIdentity>;
  try {
    identity = resolveStdioIdentity();
  } catch (err: unknown) {
    throw new ValidationError(err instanceof Error ? err.message : String(err));
  }
  return {
    repository: identity.repository,
    user_id: toUserId(identity.user_id),
    role: identity.role,
  };
}

export function requireRequestContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new AuthorizationError("No request context available");
  }
  return ctx;
}
