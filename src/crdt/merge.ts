/**
 * CRDT merge logic for Engram memory sync.
 *
 * Uses per-field Last-Writer-Wins (LWW) registers backed by Hybrid Logical Clocks,
 * G-Set union for tags, and delete-dominates tombstone semantics.
 */

import { HybridClock } from "./hlc.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields tracked by per-field LWW */
export const LWW_FIELDS = [
  "content",
  "summary",
  "memory_type",
  "scope",
  "importance",
  "status",
  "source",
  "user_id",
  "valid_from",
  "valid_until",
  "expires_at",
] as const;

export type LwwField = (typeof LWW_FIELDS)[number];

/** CRDT metadata attached to each memory */
export interface CRDTMetadata {
  hlc: string;
  field_hlcs: Partial<Record<LwwField, string>>;
}

/** A memory with CRDT metadata for sync */
export interface CRDTMemory {
  id: string;
  [key: string]: unknown;
  // CRDT fields
  hlc: string;
  field_hlcs: Partial<Record<LwwField, string>>;
  tags: string[];
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ZERO_HLC = HybridClock.serialize(HybridClock.ZERO);

/**
 * Compare two serialized HLC strings. Returns positive if a > b, negative if
 * a < b, zero if equal. Falls back to lexicographic ordering which is
 * deterministic and consistent across nodes.
 */
function compareHlcStrings(a: string | undefined, b: string | undefined): number {
  const aStr = a ?? ZERO_HLC;
  const bStr = b ?? ZERO_HLC;

  // Try structured comparison first
  try {
    const hlcA = HybridClock.parse(aStr);
    const hlcB = HybridClock.parse(bStr);
    const cmp = HybridClock.compare(hlcA, hlcB);
    if (cmp !== 0) return cmp;
    // Wall time and counter are equal — deterministic tiebreak on serialized form
    if (aStr < bStr) return -1;
    if (aStr > bStr) return 1;
    return 0;
  } catch {
    // If parsing fails, fall back to pure lexicographic compare
    if (aStr < bStr) return -1;
    if (aStr > bStr) return 1;
    return 0;
  }
}

/**
 * Pick the "later" of two nullable ISO-ish date strings using HLC comparison.
 * Used for deleted_at tombstone merging.
 */
function maxDateString(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * Pick the "earlier" of two values, treating null/undefined as +infinity.
 */
function minValue<T>(a: T | null | undefined, b: T | null | undefined): T | null | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return a <= b ? a : b;
}

/**
 * Pick the "later" of two values, treating null/undefined as -infinity.
 */
function maxValue<T>(a: T | null | undefined, b: T | null | undefined): T | null | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return a >= b ? a : b;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge two versions of the same memory (same ID).
 *
 * Deterministic: merge(a, b) === merge(b, a) (commutative).
 * Also idempotent and associative.
 */
export function mergeMemory(local: CRDTMemory, remote: CRDTMemory): CRDTMemory {
  // Start from a shallow copy of local as the base
  const result: CRDTMemory = { ...local };

  // --- Per-field LWW ---
  const mergedFieldHlcs: Partial<Record<LwwField, string>> = {};

  for (const field of LWW_FIELDS) {
    const localHlc = local.field_hlcs[field];
    const remoteHlc = remote.field_hlcs[field];

    const cmp = compareHlcStrings(localHlc, remoteHlc);

    if (cmp >= 0) {
      // Local wins or equal — keep local value & HLC
      result[field] = local[field];
      if (localHlc !== undefined) {
        mergedFieldHlcs[field] = localHlc;
      }
      if (remoteHlc !== undefined && localHlc === undefined) {
        mergedFieldHlcs[field] = remoteHlc;
      }
    } else {
      // Remote wins
      result[field] = remote[field];
      if (remoteHlc !== undefined) {
        mergedFieldHlcs[field] = remoteHlc;
      }
    }

    // Ensure we always have the max HLC for this field
    if (localHlc !== undefined && remoteHlc !== undefined) {
      mergedFieldHlcs[field] = cmp >= 0 ? localHlc : remoteHlc;
    } else if (localHlc !== undefined) {
      mergedFieldHlcs[field] = localHlc;
    } else if (remoteHlc !== undefined) {
      mergedFieldHlcs[field] = remoteHlc;
    }
  }

  result.field_hlcs = mergedFieldHlcs;

  // --- Tags (G-Set: grow-only union) ---
  result.tags = mergeTags(local.tags, remote.tags);

  // --- Deleted tombstone (delete dominates) ---
  if (local.deleted_at !== null || remote.deleted_at !== null) {
    result.deleted_at = maxDateString(local.deleted_at, remote.deleted_at);
  } else {
    result.deleted_at = null;
  }

  // --- Overall HLC: max of both ---
  result.hlc = compareHlcStrings(local.hlc, remote.hlc) >= 0 ? local.hlc : remote.hlc;

  // --- Non-LWW fields ---

  // created_at: earlier value
  const localCreatedAt = local["created_at"];
  const remoteCreatedAt = remote["created_at"];
  result["created_at"] = minValue(localCreatedAt, remoteCreatedAt);

  // access_count: maximum
  const localCount = (local["access_count"] as number | undefined) ?? 0;
  const remoteCount = (remote["access_count"] as number | undefined) ?? 0;
  result["access_count"] = Math.max(localCount, remoteCount);

  // last_accessed_at: latest
  result["last_accessed_at"] = maxValue(local["last_accessed_at"], remote["last_accessed_at"]);

  // embedding: prefer non-null, prefer remote (cloud generates embeddings)
  const localEmbedding = local["embedding"];
  const remoteEmbedding = remote["embedding"];
  if (remoteEmbedding != null) {
    result["embedding"] = remoteEmbedding;
  } else if (localEmbedding != null) {
    result["embedding"] = localEmbedding;
  }

  // Immutable identity fields — always use local (they should be identical)
  result.id = local.id;
  result["org_id"] = local["org_id"];
  result["team_id"] = local["team_id"];

  return result;
}

/**
 * Merge two tag sets using G-Set semantics (union).
 * Tags are grow-only in merge context — explicit removal only via `forget`.
 */
export function mergeTags(local: string[], remote: string[]): string[] {
  const set = new Set([...local, ...remote]);
  return [...set].sort();
}

/**
 * Check if a remote memory has any newer fields than the local version.
 * Used to skip unnecessary writes during sync.
 */
export function hasNewerFields(local: CRDTMemory, remote: CRDTMemory): boolean {
  for (const field of LWW_FIELDS) {
    const cmp = compareHlcStrings(local.field_hlcs[field], remote.field_hlcs[field]);
    if (cmp < 0) {
      return true;
    }
  }

  // Check if remote has tags not in local
  const localTagSet = new Set(local.tags);
  for (const tag of remote.tags) {
    if (!localTagSet.has(tag)) {
      return true;
    }
  }

  // Check if remote has a newer deleted_at
  if (remote.deleted_at !== null && local.deleted_at === null) {
    return true;
  }
  if (remote.deleted_at !== null && local.deleted_at !== null && remote.deleted_at > local.deleted_at) {
    return true;
  }

  return false;
}

/**
 * Stamp CRDT metadata on a memory being written locally.
 * Sets the HLC and field_hlcs for all modified fields.
 */
export function stampWrite(memory: CRDTMemory, modifiedFields: LwwField[], clock: HybridClock): CRDTMemory {
  const now = HybridClock.serialize(clock.now());
  const result: CRDTMemory = { ...memory };

  result.hlc = now;
  result.field_hlcs = { ...memory.field_hlcs };

  for (const field of modifiedFields) {
    result.field_hlcs[field] = now;
  }

  return result;
}
