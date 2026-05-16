import { getRequestContextOrDefault, requestContext } from "../context.js";
import { resolveStdioIdentity } from "../services/git-identity.service.js";
import { logger } from "../services/logger.js";
import { AuthorizationError } from "../errors.js";
import { EngramError } from "../errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wrap an MCP tool handler with error handling.
 * Catches exceptions and returns proper isError responses.
 * Logs with request context for production debugging.
 */
export function withErrorHandling<TParams = Record<string, unknown>>(
  handler: (params: TParams) => Promise<CallToolResult>,
  toolName?: string,
): (params: TParams) => Promise<CallToolResult> {
  return async (params: TParams): Promise<CallToolResult> => {
    try {
      return await handler(params);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const ctx = getRequestContextOrDefault();
      logger.error("Tool error", {
        tool: toolName,
        error: message,
        code: err instanceof EngramError ? err.code : undefined,
        stack: err instanceof Error ? err.stack : undefined,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
        team_slug: ctx.team_slug,
      });
      if (err instanceof EngramError) {
        const detail =
          "originalError" in err && err.originalError instanceof Error && err.originalError.message
            ? `: ${err.originalError.message}`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Error [${err.code}]: ${err.message}${detail}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

/**
 * Assert that the current user has write (or admin) permission.
 * Throws if the user only has reader role.
 */
export function requireWritePermission(): void {
  const ctx = getRequestContextOrDefault();
  if (ctx.role === "reader") {
    throw new AuthorizationError("Write access required");
  }
}

/**
 * Assert that the current user has admin permission.
 * Throws if the user has reader or writer role.
 */
export function requireAdminPermission(): void {
  const ctx = getRequestContextOrDefault();
  if (ctx.role !== "admin") {
    throw new AuthorizationError("Admin access required");
  }
}

/**
 * Strip keys with `undefined` values from an object.
 * Bridges Zod's `T | undefined` for optional fields to TypeScript's `prop?: T`
 * required by `exactOptionalPropertyTypes`.
 */
export function stripUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T as T[K] extends undefined ? never : K]: T[K] } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as ReturnType<
    typeof stripUndefined<T>
  >;
}

/** Get repo-level auto-tags. Only in stdio mode (no requestContext store). */
export function getRepoTags(): string[] {
  if (requestContext.getStore()) return []; // HTTP mode — skip git subprocess calls
  return resolveStdioIdentity().repo_tags;
}

/** Merge repo-level auto-tags into user-provided tags (deduplicated). */
export function mergeRepoTags(userTags: string[], repoTags: string[]): string[] {
  const merged = [...userTags];
  for (const tag of repoTags) {
    if (!merged.includes(tag)) {
      merged.push(tag);
    }
  }
  return merged;
}
