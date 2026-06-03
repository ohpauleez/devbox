import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { RequiredTags } from "./types.js";

const VALID_ENV_VALUES = new Set(["prod", "preprod", "staging", "dev"]);
const VALID_CUSTOMER_DATA_VALUES = new Set(["true", "false"]);

/**
 * Built-in required tag defaults for first-run config synthesis.
 */
export const BUILTIN_REQUIRED_TAG_DEFAULTS: RequiredTags = {
  env: "dev",
  service: "devbox",
  version: "0000000",
  "customer-data": "false",
  team: "devbox",
};

/**
 * Validate required tag values.
 *
 * @param tags required tag set
 * @returns success when all required value constraints hold
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
 * Merge built-in defaults with user defaults.
 *
 * @param configured configured required tags from config
 * @returns merged tags before validation
 */
export function mergeRequiredTags(configured: RequiredTags): RequiredTags {
  return {
    ...BUILTIN_REQUIRED_TAG_DEFAULTS,
    ...configured,
  };
}
