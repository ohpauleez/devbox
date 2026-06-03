import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type RemotePath = string & { readonly __brand: "RemotePath" };

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Validate remote destination path for cp.
 */
export function parseRemotePath(raw: string): Result<RemotePath, DevboxError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err(makeError("ValidationError", "remote path must not be empty"));
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return err(makeError("ValidationError", "remote path must not contain control characters"));
  }
  return ok(trimmed as RemotePath);
}
