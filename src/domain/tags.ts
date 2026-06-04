import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { RequiredTags } from "./types.js";

const VALID_ENV_VALUES = new Set(["prod", "preprod", "staging", "dev"]);
const VALID_CUSTOMER_DATA_VALUES = new Set(["true", "false"]);

/**
 * Built-in required tag defaults for first-run config synthesis.
 *
 * @remarks
 * Invariant: satisfies all `RequiredTags` validation constraints.
 * Used as the base layer in `mergeRequiredTags` and `synthesizeFirstRunConfig`.
 */
export const BUILTIN_REQUIRED_TAG_DEFAULTS: RequiredTags = {
  env: "dev",
  service: "devbox",
  version: "0000000",
  "customer-data": "false",
  team: "devbox",
};

/**
 * Validate required tag values against organizational constraints.
 *
 * @param tags - required tag set to validate
 * @returns `ok(undefined)` when all constraints hold; `ConfigError` on violation
 *
 * @remarks
 * Precondition: `tags` has all five required keys (env, service, version, customer-data, team).
 * Postcondition: on success, all tag values satisfy their domain constraints.
 * Invariant: validation is stateless and deterministic.
 * Failures: `ConfigError` when env is not in allowed set, service is not "devbox",
 * version length is outside 7-40, customer-data is not "true"/"false", or team is empty.
 *
 * @example
 * ```ts
 * import { validateRequiredTags } from "./tags.js";
 *
 * const result = validateRequiredTags({
 *   env: "dev", service: "devbox", version: "0000000",
 *   "customer-data": "false", team: "platform",
 * });
 * // result.ok === true
 *
 * const bad = validateRequiredTags({
 *   env: "invalid", service: "devbox", version: "0000000",
 *   "customer-data": "false", team: "platform",
 * });
 * // bad.ok === false, bad.error.category === "ConfigError"
 * ```
 */
export function validateRequiredTags(tags: RequiredTags): Result<void, DevboxError> {
  if (!VALID_ENV_VALUES.has(tags.env)) {
    return err(makeError("ConfigError", "defaults.tags.env must be one of prod, preprod, staging, dev"));
  }
  if (tags.service !== "devbox") {
    return err(makeError("ConfigError", "defaults.tags.service must equal devbox"));
  }
  if (tags.version.length < 7 || tags.version.length > 40) {
    return err(makeError("ConfigError", "defaults.tags.version must be 7 to 40 characters"));
  }
  if (!VALID_CUSTOMER_DATA_VALUES.has(tags["customer-data"])) {
    return err(makeError("ConfigError", "defaults.tags.customer-data must be true or false"));
  }
  if (tags.team.trim().length === 0) {
    return err(makeError("ConfigError", "defaults.tags.team must be a non-empty identifier"));
  }
  return ok(undefined);
}

/**
 * Merge built-in defaults with user-configured required tags.
 *
 * @param configured - user-configured required tags from config file
 * @returns merged tag set with user values taking precedence over built-in defaults
 *
 * @remarks
 * Precondition: `configured` has the `RequiredTags` shape (all keys present).
 * Postcondition: returned object has all required tag keys; user values override built-in defaults.
 * Invariant: built-in defaults are never mutated. Spread order guarantees user precedence.
 *
 * @example
 * ```ts
 * import { mergeRequiredTags } from "./tags.js";
 *
 * const merged = mergeRequiredTags({
 *   env: "staging", service: "devbox", version: "abc1234",
 *   "customer-data": "false", team: "infra",
 * });
 * // merged.env === "staging" (user override)
 * // merged.team === "infra" (user override)
 * ```
 */
export function mergeRequiredTags(configured: RequiredTags): RequiredTags {
  return {
    ...BUILTIN_REQUIRED_TAG_DEFAULTS,
    ...configured,
  };
}
