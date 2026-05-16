/**
 * A discriminated union for representing success/failure without exceptions.
 * Enables type-safe error handling where failure paths are visible in signatures.
 *
 * @example
 * ```ts
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) return Err("Division by zero");
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) console.log(result.value); // 5
 * else console.log(result.error); // never reached
 * ```
 */

export type Result<T, E = Error> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Create a success Result. */
export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Create a failure Result. */
export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Transform the success value, leaving errors untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? Ok(fn(result.value)) : result;
}

/** Chain a fallible operation onto a success value. */
export function flatMap<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Transform the error, leaving success untouched. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : Err(fn(result.error));
}

/** Extract the value or use a fallback. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Extract the value or throw the error (escape hatch for interop). */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

/** Wrap a Promise that may reject into a Result. */
export async function fromPromise<T, E = Error>(
  promise: Promise<T>,
  mapError?: (err: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return Ok(await promise);
  } catch (err: unknown) {
    if (mapError) return Err(mapError(err));
    return Err(err as E);
  }
}

/** Wrap a synchronous function that may throw into a Result. */
export function fromThrowable<T, E = Error>(fn: () => T, mapError?: (err: unknown) => E): Result<T, E> {
  try {
    return Ok(fn());
  } catch (err: unknown) {
    if (mapError) return Err(mapError(err));
    return Err(err as E);
  }
}

/** Collect an array of Results into a Result of array. Short-circuits on first error. */
export function collect<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return Ok(values);
}
