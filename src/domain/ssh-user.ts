import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { BoxConfig, DefaultsConfig, SshUser } from "./types.js";

/**
 * Input sources used for SSH-user precedence resolution.
 */
export interface SshUserResolutionInput {
  readonly invocationOverride?: string;
  readonly box: BoxConfig;
  readonly defaults: DefaultsConfig;
}

/**
 * Resolve SSH user for remote-access commands.
 *
 * @param input resolution sources in precedence order
 * @returns resolved SSH user or ValidationError
 */
export function resolveSshUser(input: SshUserResolutionInput): Result<SshUser, DevboxError> {
  const candidate =
    input.invocationOverride?.trim() ||
    input.box.sshUser ||
    input.defaults.sshUser;

  if (candidate === undefined || candidate.length === 0) {
    return err(
      makeError(
        "ValidationError",
        "ssh user is required; provide --ssh-user, boxes.<alias>.sshUser, or defaults.sshUser",
      ),
    );
  }

  return ok(candidate as SshUser);
}
