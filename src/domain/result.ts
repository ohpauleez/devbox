/**
 * Generic result shape for expected success and failure outcomes.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Build a successful Result.
 *
 * @param value success payload
 * @returns tagged success result
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Build a failed Result.
 *
 * @param error domain or adapter failure payload
 * @returns tagged failure result
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
