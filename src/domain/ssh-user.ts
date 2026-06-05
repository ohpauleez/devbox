import { makeTypedError, type ValidationError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { BoxConfig, DefaultsConfig, SshUser } from "./types.js";

/**
 * Pattern for safe SSH user identifiers.
 * Rejects whitespace, control characters, and empty values.
 */
const SSH_USER_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;

/**
 * Input sources used for SSH-user precedence resolution.
 *
 * @remarks
 * Precedence order: `invocationOverride` > `box.sshUser` > `defaults.sshUser`.
 */
export interface SshUserResolutionInput {
  /** CLI flag override (e.g., --ssh-user). Highest precedence. */
  readonly invocationOverride?: string;
  /** Per-box config. Middle precedence via `box.sshUser`. */
  readonly box: BoxConfig;
  /** Global defaults. Lowest precedence via `defaults.sshUser`. */
  readonly defaults: DefaultsConfig;
}

/**
 * Resolve SSH user for remote-access commands using precedence hierarchy.
 *
 * @param input - resolution sources: invocation override, box config, then defaults
 * @returns branded `SshUser` on success; `ValidationError` on failure
 *
 * @remarks
 * Precondition: `input.box` and `input.defaults` are schema-valid config objects.
 * Postcondition: returned user is a non-empty string free of control characters and whitespace.
 * Invariant: precedence is invocationOverride > box.sshUser > defaults.sshUser.
 * Failures: `ValidationError` when no source provides a valid SSH user, or when
 * the invocation override contains control characters or whitespace.
 * Safety: validates invocation override against SSH_USER_PATTERN to prevent injection
 * of control characters into shell commands via --ssh-user.
 *
 * @example
 * ```ts
 * import { resolveSshUser } from "./ssh-user.js";
 * import type { BoxConfig, DefaultsConfig } from "./types.js";
 *
 * const result = resolveSshUser({
 *   invocationOverride: "ubuntu",
 *   box: { instanceId: "i-abc" } as BoxConfig,
 *   defaults: { tags: { ... }, sshUser: "ec2-user" } as DefaultsConfig,
 * });
 * // result.ok === true
 * // result.value === "ubuntu" (invocation override wins)
 * ```
 */
export function resolveSshUser(input: SshUserResolutionInput): Result<SshUser, ValidationError> {
  // Validate invocation override explicitly before precedence resolution.
  // Box and defaults values are already validated during config parsing.
  if (input.invocationOverride !== undefined) {
    const trimmed = input.invocationOverride.trim();
    if (trimmed.length === 0) {
      // Fall through to next precedence level
    } else if (!SSH_USER_PATTERN.test(trimmed)) {
      return err(
        makeTypedError(
          "ValidationError",
          "ssh user override contains invalid characters (whitespace or control characters not allowed)",
        ),
      );
    } else {
      return ok(trimmed as SshUser);
    }
  }

  const candidate = input.box.sshUser || input.defaults.sshUser;

  if (candidate === undefined || candidate.length === 0) {
    return err(
      makeTypedError(
        "ValidationError",
        "ssh user is required; provide --ssh-user, boxes.<alias>.sshUser, or defaults.sshUser",
      ),
    );
  }

  return ok(candidate as SshUser);
}
