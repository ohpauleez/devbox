/**
 * @module result
 *
 * Provides the core `Result<T, E>` discriminated union for representing
 * expected success and failure outcomes without exceptions.
 *
 * @remarks
 * All domain and adapter functions that may fail in an expected way return
 * `Result<T, E>` rather than throwing. This keeps error handling explicit
 * and composable through the call stack. The `ok` discriminant field allows
 * exhaustive narrowing in TypeScript control flow.
 *
 * Invariant: a `Result` is always exactly one of `{ ok: true, value: T }` or
 * `{ ok: false, error: E }` — never both, never neither.
 */

/**
 * Generic result shape for expected success and failure outcomes.
 *
 * @remarks
 * Discriminated on the `ok` field. When `ok` is `true`, `value` holds the
 * success payload of type `T`. When `ok` is `false`, `error` holds the
 * failure payload of type `E`.
 *
 * Invariant: both branches are readonly to prevent mutation after creation.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Build a successful Result.
 *
 * @param value - success payload
 * @returns tagged success result with `ok: true` and the provided value
 *
 * @remarks
 * Precondition: none — any value of type `T` is accepted.
 * Postcondition: returned object satisfies `result.ok === true` and `result.value === value`.
 * Invariant: the returned object is frozen by structural readonly typing.
 *
 * @example
 * ```ts
 * import { ok } from "./result.js";
 *
 * const result = ok(42);
 * // result.ok === true
 * // result.value === 42
 * ```
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Build a failed Result.
 *
 * @param error - domain or adapter failure payload
 * @returns tagged failure result with `ok: false` and the provided error
 *
 * @remarks
 * Precondition: none — any value of type `E` is accepted.
 * Postcondition: returned object satisfies `result.ok === false` and `result.error === error`.
 * Invariant: the returned object is frozen by structural readonly typing.
 *
 * @example
 * ```ts
 * import { err } from "./result.js";
 * import { makeError } from "./errors.js";
 *
 * const result = err(makeError("ValidationError", "alias is invalid"));
 * // result.ok === false
 * // result.error.category === "ValidationError"
 * ```
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
