/**
 * Domain error hierarchy for Engram.
 * Enables type-safe error handling and structured error responses.
 */

export class EngramError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends EngramError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, "NOT_FOUND", 404);
  }
}

export class ValidationError extends EngramError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

export class AuthorizationError extends EngramError {
  constructor(message = "Permission denied") {
    super(message, "AUTHORIZATION_ERROR", 403);
  }
}

export class DatabaseError extends EngramError {
  readonly originalError?: Error | undefined;

  constructor(message: string, originalError?: Error) {
    super(message, "DATABASE_ERROR", 500);
    this.originalError = originalError;
  }
}

export class ExternalServiceError extends EngramError {
  constructor(service: string, message: string) {
    super(`${service}: ${message}`, "EXTERNAL_SERVICE_ERROR", 502);
  }
}

/**
 * Wrap a database operation so that raw driver exceptions (postgres, sqlite)
 * are caught and re-thrown as `DatabaseError` with a descriptive label.
 * Keeps `DatabaseError` instances as-is to avoid double-wrapping.
 */
export async function dbQuery<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(label, err instanceof Error ? err : undefined);
  }
}
