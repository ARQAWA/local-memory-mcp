type Brand<T, B> = T & { readonly __brand: B };

export type MemoryId = Brand<string, "MemoryId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type UserId = Brand<string, "UserId">;

export function MemoryId(value: string): MemoryId {
  return value as MemoryId;
}

export function RepositoryId(value: string): RepositoryId {
  return value as RepositoryId;
}

export function UserId(value: string): UserId {
  return value as UserId;
}

export function isMemoryId(value: unknown): value is MemoryId {
  return typeof value === "string";
}

export function isRepositoryId(value: unknown): value is RepositoryId {
  return typeof value === "string";
}

export function isUserId(value: unknown): value is UserId {
  return typeof value === "string";
}
