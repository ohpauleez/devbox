/**
 * @module cp
 *
 * Implements the `cp` command: copy a local file to a remote path on the current
 * devbox instance. The flow is:
 *
 * 1. Validate local file exists and is a regular file (no directories, no symlink tricks).
 * 2. Validate the remote destination path is safe (no traversal, no dangerous targets).
 * 3. Resolve all remote-access preconditions (config, running state, SSM, key staging).
 * 4. Upload the file via SCP to a temporary remote location.
 * 5. Finalize: atomically move the temp file to the target destination.
 * 6. Update `lastConnectAt` in config.
 * 7. Clean up temporary SSH keys (unconditionally in `finally`).
 *
 * The two-phase upload (temp → finalize) ensures that a failed transfer never
 * leaves partial content at the final destination path.
 *
 * @example
 * ```ts
 * const result = await runCpCommand("./local.txt", "/home/ubuntu/remote.txt");
 * if (result.ok) {
 *   console.log(`Copied to: ${result.value.stdoutLines[0]}`);
 * }
 * ```
 */

import { commitConfig } from "../../adapters/config-store.js";
import {
  cleanupLocalTempKeys,
  finalizeRemoteFile,
  uploadFileOverScp,
  validateLocalRegularFile,
} from "../../adapters/ssh-cli.js";
import { makeError } from "../../domain/errors.js";
import { parseRemotePath } from "../../domain/remote-path.js";
import { err, ok } from "../../domain/result.js";
import { REAL_CLOCK, type Clock } from "../../domain/wait-policy.js";
import type { DevboxConfig } from "../../domain/types.js";
import type { CommandResult } from "../context.js";
import { resolveRemoteAccessPreconditions } from "../remote-access.js";

/**
 * Copy a local file to a remote path on the current devbox instance.
 *
 * @param localPath - Path to the local file to upload. Must exist and be a regular file.
 * @param remotePathRaw - Remote destination path. Validated for safety (no traversal attacks).
 * @param invocationSshUser - Optional invocation-level SSH user override.
 * @param clock - Clock abstraction for testability; defaults to real wall-clock time.
 *
 * @returns On success: the validated remote path in `stdoutLines[0]`, confirming the
 *   file is now at that location. On error: a typed {@link DevboxError}.
 *
 * @throws Never throws — all failures are returned as `Result.err`.
 *
 * @remarks
 * Preconditions:
 * - `localPath` must point to an existing regular file (not a directory or symlink).
 * - `remotePathRaw` must pass remote path validation (absolute, no traversal).
 * - A current box must be selected, running, and SSM-ready.
 *
 * Postconditions on success:
 * - The file exists at the remote destination with correct content.
 * - `lastConnectAt` is updated in the persisted config.
 * - All temporary local SSH keys are cleaned up.
 *
 * Safety:
 * - Failed transfers never leave partial content at the final destination
 *   (upload goes to a temp path, then is atomically moved).
 * - Temporary keys are cleaned up in the `finally` block on all exit paths.
 *
 * Failure forms:
 * - `ValidationError` — local file missing/not-regular, or remote path unsafe.
 * - All failures from {@link resolveRemoteAccessPreconditions}.
 * - `TransportError` — SCP upload or remote finalize command failed.
 * - `ConsistencyError` — copy succeeded but `lastConnectAt` persistence failed.
 *
 * Ordering: local and remote path validation happen before any remote interaction
 * to fail fast without incurring SSH setup costs.
 *
 * Concurrency: not safe to call concurrently for the same box (shares key state).
 *
 * @example
 * ```ts
 * import { runCpCommand } from "./cp.js";
 *
 * const result = await runCpCommand("./config.yaml", "/etc/myapp/config.yaml");
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   process.exit(1);
 * }
 * console.log(`File deployed to ${result.value.stdoutLines[0]}`);
 * ```
 */
export async function runCpCommand(
  localPath: string,
  remotePathRaw: string,
  invocationSshUser?: string,
  clock: Clock = REAL_CLOCK,
): Promise<CommandResult> {
  // Step 1: Validate local file before any remote interaction.
  // Why: fail fast if the source doesn't exist — avoids wasting time on key staging.
  const localValidation = await validateLocalRegularFile(localPath);
  if (!localValidation.ok) {
    return err(localValidation.error);
  }

  // Step 2: Validate remote path safety.
  // Why: reject path traversal attacks and dangerous destinations before connecting.
  const remotePathResult = parseRemotePath(remotePathRaw);
  if (!remotePathResult.ok) {
    return err(remotePathResult.error);
  }

  // Step 3: Resolve all remote-access preconditions (config, state, SSM, key).
  const preconditionResult = await resolveRemoteAccessPreconditions(invocationSshUser);
  if (!preconditionResult.ok) {
    return err(preconditionResult.error);
  }

  const { config, current, sshContext, key } = preconditionResult.value;

  try {
    // Step 4: Upload file via SCP to a temporary remote path.
    // Why: uploading to a temp path first ensures the final destination is never
    // left in a partial/corrupt state if the transfer is interrupted.
    const uploadResult = await uploadFileOverScp(sshContext, key, localPath);
    if (!uploadResult.ok) {
      return err(uploadResult.error);
    }

    // Step 5: Atomically move the uploaded temp file to the final destination.
    // Why: this is the commit point — only a successful move means the copy succeeded.
    const finalizeResult = await finalizeRemoteFile(
      sshContext,
      key,
      uploadResult.value,
      remotePathResult.value,
    );
    if (!finalizeResult.ok) {
      return err(finalizeResult.error);
    }

    // Step 6: Record connection timestamp for usage tracking.
    const nextBoxes = {
      ...config.boxes,
      [current.alias]: {
        ...current.box,
        lastConnectAt: clock.isoNow(),
      },
    };
    const nextConfig: DevboxConfig = {
      ...config,
      boxes: nextBoxes,
    };
    const commitResult = await commitConfig(nextConfig);
    if (!commitResult.ok) {
      return err(
        makeError(
          "ConsistencyError",
          "copy succeeded remotely but lastConnectAt update failed",
          commitResult.error.details,
        ),
      );
    }

    return ok({
      stdoutLines: [remotePathResult.value],
      stderrLines: [],
    });
  } finally {
    // Cleanup is unconditional — keys must be removed regardless of success/failure.
    await cleanupLocalTempKeys(key);
  }
}
