import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/**
 * Branded remote file path for the `cp` command.
 *
 * @remarks
 * Invariant: values are trimmed, non-empty, and contain no ASCII control characters.
 */
export type RemotePath = string & { readonly __brand: "RemotePath" };

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Validate and brand a remote destination path for the `cp` command.
 *
 * @param raw - user-supplied remote path string
 * @returns branded `RemotePath` on success; `ValidationError` on failure
 *
 * @remarks
 * Precondition: `raw` is a non-null string.
 * Postcondition: returned value is trimmed, non-empty, and contains no ASCII control characters.
 * Failures: `ValidationError` when the path is empty after trimming or contains control characters.
 * Invariant: pure function — no side effects.
 *
 * @example
 * ```ts
 * import { parseRemotePath } from "./remote-path.js";
 *
 * const result = parseRemotePath("/home/user/file.txt");
 * // result.ok === true
 * // result.value === "/home/user/file.txt"
 *
 * const bad = parseRemotePath("");
 * // bad.ok === false
 * // bad.error.category === "ValidationError"
 * ```
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
