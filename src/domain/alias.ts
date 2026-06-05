import { makeTypedError, type ValidationError } from "./errors.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import type { BoxAlias } from "./types.js";

export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const INSTANCE_ID_ADVISORY_PATTERN = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;

/**
 * Parse and validate a user alias against the allowed character pattern.
 *
 * @param raw - candidate alias string; must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`
 * @returns branded `BoxAlias` on success; `ValidationError` on failure
 *
 * @remarks
 * Precondition: `raw` is a non-null string.
 * Postcondition: returned value satisfies `ALIAS_PATTERN` and is branded as `BoxAlias`.
 * Failures: `ValidationError` when `raw` does not match the required pattern.
 * Invariant: pure function — no side effects, deterministic.
 *
 * @example
 * ```ts
 * import { parseAlias } from "./alias.js";
 *
 * const result = parseAlias("my-box-01");
 * if (result.ok) {
 *   // result.value is a branded BoxAlias
 * }
 *
 * const invalid = parseAlias("!bad");
 * // invalid.ok === false
 * // invalid.error.category === "ValidationError"
 * ```
 */
export function parseAlias(raw: string): Result<BoxAlias, ValidationError> {
  if (!ALIAS_PATTERN.test(raw)) {
    return err(
      makeTypedError(
        "ValidationError",
        "alias must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      ),
    );
  }
  return ok(raw as BoxAlias);
}

/**
 * Validate alias uniqueness in the current registry.
 *
 * @param alias - candidate alias, already validated via `parseAlias`
 * @param tracked - currently tracked alias-to-box mapping
 * @returns `ok(undefined)` when the alias is available; `ValidationError` when already tracked
 *
 * @remarks
 * Precondition: `alias` is a valid `BoxAlias` (previously parsed).
 * Postcondition: on success, `alias` is guaranteed not present in `tracked`.
 * Failures: `ValidationError` when `alias` already exists in `tracked`.
 * Invariant: does not mutate `tracked`.
 *
 * @example
 * ```ts
 * import { ensureAliasAvailable, parseAlias } from "./alias.js";
 * import type { BoxAlias } from "./types.js";
 *
 * const alias = parseAlias("dev1").value!;
 * const tracked = {} as Record<BoxAlias, unknown>;
 * const result = ensureAliasAvailable(alias, tracked);
 * // result.ok === true
 * ```
 */
export function ensureAliasAvailable(
  alias: BoxAlias,
  tracked: Readonly<Record<BoxAlias, unknown>>,
): Result<void, ValidationError> {
  if (alias in tracked) {
    return err(makeTypedError("ValidationError", `alias already tracked: ${alias}`));
  }
  return ok(undefined);
}

/**
 * Check whether an instance-id matches the advisory EC2 identifier pattern.
 *
 * @param instanceId - supplied instance identifier string
 * @returns `true` when the value matches `i-` followed by 8 or 17 hex characters
 *
 * @remarks
 * Precondition: `instanceId` is a non-null string.
 * Postcondition: result is purely advisory; a `false` return does not imply invalidity.
 * Invariant: this function is side-effect-free and deterministic.
 *
 * @example
 * ```ts
 * import { matchesInstanceIdAdvisoryPattern } from "./alias.js";
 *
 * matchesInstanceIdAdvisoryPattern("i-0a1b2c3d4e5f67890"); // true
 * matchesInstanceIdAdvisoryPattern("custom-id");           // false
 * ```
 */
export function matchesInstanceIdAdvisoryPattern(instanceId: string): boolean {
  return INSTANCE_ID_ADVISORY_PATTERN.test(instanceId);
}
