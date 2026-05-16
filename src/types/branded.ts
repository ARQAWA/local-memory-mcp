/**
 * Branded types for type-safe IDs throughout the application.
 *
 * These types use TypeScript's branded type pattern to create distinct types
 * from strings, preventing accidental misuse (e.g., passing a UserId where
 * an OrgId is expected).
 *
 * The branded types are compatible with `string` but provide compile-time
 * type safety. Use the helper functions to create branded values.
 */

/**
 * Brand utility type.
 * Creates a nominal type by intersecting T with a unique brand symbol.
 */
type Brand<T, B> = T & { readonly __brand: B };

/**
 * Memory ID — uniquely identifies a memory record.
 */
export type MemoryId = Brand<string, "MemoryId">;

/**
 * User ID — uniquely identifies a user within an organization.
 */
export type UserId = Brand<string, "UserId">;

/**
 * Organization ID — uniquely identifies an organization.
 */
export type OrgId = Brand<string, "OrgId">;

/**
 * Team slug — uniquely identifies a team within an organization.
 */
export type TeamSlug = Brand<string, "TeamSlug">;

/**
 * Create a MemoryId from a string.
 * No validation — use for trusted sources (e.g., database results).
 */
export function MemoryId(value: string): MemoryId {
  return value as MemoryId;
}

/**
 * Create a UserId from a string.
 * No validation — use for trusted sources (e.g., JWT claims, database results).
 */
export function UserId(value: string): UserId {
  return value as UserId;
}

/**
 * Create an OrgId from a string.
 * No validation — use for trusted sources (e.g., JWT claims, database results).
 */
export function OrgId(value: string): OrgId {
  return value as OrgId;
}

/**
 * Create a TeamSlug from a string.
 * No validation — use for trusted sources (e.g., JWT claims, database results).
 */
export function TeamSlug(value: string): TeamSlug {
  return value as TeamSlug;
}

/**
 * Type guard to check if a value is a MemoryId.
 * Note: This is a runtime check that only verifies the value is a string.
 * The branded type is purely compile-time.
 */
export function isMemoryId(value: unknown): value is MemoryId {
  return typeof value === "string";
}

/**
 * Type guard to check if a value is a UserId.
 */
export function isUserId(value: unknown): value is UserId {
  return typeof value === "string";
}

/**
 * Type guard to check if a value is an OrgId.
 */
export function isOrgId(value: unknown): value is OrgId {
  return typeof value === "string";
}

/**
 * Type guard to check if a value is a TeamSlug.
 */
export function isTeamSlug(value: unknown): value is TeamSlug {
  return typeof value === "string";
}
