/**
 * Central exports for all type definitions.
 */

// Branded types (types and constructor functions have same name, so export separately)
export type { MemoryId, UserId, OrgId, TeamSlug } from "./branded.js";
export {
  MemoryId as toMemoryId,
  UserId as toUserId,
  OrgId as toOrgId,
  TeamSlug as toTeamSlug,
  isMemoryId,
  isUserId,
  isOrgId,
  isTeamSlug,
} from "./branded.js";

// Memory types
export type {
  Memory,
  MemoryType,
  MemoryScope,
  RelationType,
  MemoryMetadata,
  RecallResult,
  MemoryStats,
  RememberInput,
  RememberFactInput,
  RememberDecisionInput,
  RecallInput,
  GetContextForInput,
  ForgetInput,
  CorrectInput,
  ListMemoriesInput,
  SearchMemoriesInput,
} from "./memory.js";

export {
  memoryTypes,
  memoryScopes,
  relationTypes,
  matchTypes,
  MemoryTypeSchema,
  MemoryScopeSchema,
  RelationTypeSchema,
  tagSchema,
  tagsArraySchema,
  tagsFilterSchema,
  RememberSchema,
  RememberFactSchema,
  RememberDecisionSchema,
  RecallSchema,
  GetContextForSchema,
  ForgetSchema,
  CorrectSchema,
  ListMemoriesSchema,
  SearchMemoriesSchema,
  GetMemoryStatsSchema,
  entryTypeToMemoryType,
  memoryTypeToEntryType,
} from "./memory.js";

// Auth types
export type { Role, AuthContext, AuthContextBranded } from "./auth.js";
export { roleValues, AuthContextSchema } from "./auth.js";

// Result types
export type { Result } from "./result.js";
export { Ok, Err, map, flatMap, mapErr, unwrapOr, unwrap, fromPromise, fromThrowable, collect } from "./result.js";

// Scoring types
export type { ScoredMemory } from "./scoring.js";
