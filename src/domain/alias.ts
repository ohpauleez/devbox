import { makeError } from "./errors.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import type { BoxAlias } from "./types.js";

export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const INSTANCE_ID_ADVISORY_PATTERN = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;

/**
 * Parse and validate a user alias.
 *
 * @param raw candidate alias
 * @returns branded alias on success or ValidationError
 */
export function parseAlias(raw: string): Result<BoxAlias, ReturnType<typeof makeError>> {
  if (!ALIAS_PATTERN.test(raw)) {
    return err(
      makeError(
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
 * @param alias candidate alias
 * @param tracked currently tracked aliases
 * @returns success when alias is not already tracked
 */
export function ensureAliasAvailable(
  alias: BoxAlias,
  tracked: Readonly<Record<BoxAlias, unknown>>,
): Result<void, ReturnType<typeof makeError>> {
  if (alias in tracked) {
    return err(makeError("ValidationError", `alias already tracked: ${alias}`));
  }
  return ok(undefined);
}

/**
 * Check whether instance-id shape matches the advisory EC2 pattern.
 *
 * @param instanceId supplied instance identifier
 * @returns true when advisory format matches
 */
export function matchesInstanceIdAdvisoryPattern(instanceId: string): boolean {
  return INSTANCE_ID_ADVISORY_PATTERN.test(instanceId);
}
