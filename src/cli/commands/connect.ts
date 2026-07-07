/**
 * @module connect
 *
 * Implements the `connect` command: establish an interactive SSH session to the
 * current devbox instance. This command composes the shared remote-access
 * precondition chain with SSH session management and post-session bookkeeping.
 *
 * Flow:
 * 1. Resolve all remote-access preconditions (config, instance running, SSM, key staged).
 * 2. Start the interactive SSH session (blocks until the user exits).
 * 3. Update `lastConnectAt` in config to track usage.
 * 4. Clean up temporary SSH keys (in `finally`, ensuring cleanup on all exit paths).
 *
 * @example
 * ```ts
 * const result = await runConnectCommand("ubuntu");
 * if (!result.ok) { handleError(result.error); }
 * // SSH session completed; result.value.exitCode reflects SSH exit status
 * ```
 */

import { commitConfig } from "../../adapters/config-store.js";
import { cleanupLocalTempKeys, startInteractiveSsh } from "../../adapters/ssh-cli.js";
import { makeError } from "../../domain/errors.js";
import { err, ok } from "../../domain/result.js";
import { REAL_CLOCK, type Clock } from "../../domain/wait-policy.js";
import type { DevboxConfig } from "../../domain/types.js";
import type { CommandResult } from "../context.js";
import { resolveRemoteAccessPreconditions } from "../remote-access.js";

/**
 * Start an interactive SSH session to the current devbox instance.
 *
 * @param invocationSshUser - Optional invocation-level SSH user override.
 *   When provided, takes precedence over box-level and default-level configuration.
 * @param forwardAgent - When `true`, request SSH agent forwarding for this session.
 *   Requires the resolved key material to have come from a local agent; otherwise
 *   {@link resolveRemoteAccessPreconditions} fails before any AWS/SSM interaction.
 *   Defaults to `false` (no change from prior behavior).
 * @param clock - Clock abstraction for testability; defaults to real wall-clock time.
 *
 * @returns On success: empty `stdoutLines` with optional non-zero `exitCode` reflecting
 *   the SSH process exit status (preserving the SSH exit behavior contract).
 *   On error: a typed {@link DevboxError} from any precondition or transport failure.
 *
 * @throws Never throws — all failures are returned as `Result.err`.
 *
 * @remarks
 * Preconditions:
 * - A current box must be selected with a valid instance ID.
 * - The instance must be running and SSM-ready.
 * - SSH key material must be available locally (generated if needed).
 * - If `forwardAgent` is `true`, that key material must come from a local agent.
 *
 * Postconditions on success:
 * - The SSH session has completed (user exited or connection dropped).
 * - `lastConnectAt` is updated in the persisted config.
 * - All temporary SSH key files are removed from the local filesystem.
 *
 * Safety:
 * - Temporary keys are cleaned up in the `finally` block, ensuring cleanup
 *   even if the SSH session is interrupted by signals or unexpected errors.
 * - The SSH exit code is propagated so callers can distinguish clean exits
 *   from connection failures.
 *
 * Failure forms:
 * - All failures from {@link resolveRemoteAccessPreconditions} (see that function),
 *   including `ValidationError` when `forwardAgent` is requested without a usable
 *   local agent.
 * - `TransportError` — SSH session could not be established.
 * - `ConsistencyError` — session succeeded but `lastConnectAt` persistence failed.
 *
 * Concurrency: not safe to call concurrently for the same box (shares key state).
 *
 * @example
 * ```ts
 * import { runConnectCommand } from "./connect.js";
 *
 * const result = await runConnectCommand(undefined, true);
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   process.exit(1);
 * }
 * process.exit(result.value.exitCode ?? 0);
 * ```
 */
export async function runConnectCommand(
  invocationSshUser?: string,
  forwardAgent = false,
  clock: Clock = REAL_CLOCK,
): Promise<CommandResult> {
  // Resolve all remote-access preconditions: config, instance state, SSM, key staging.
  const preconditionResult = await resolveRemoteAccessPreconditions(invocationSshUser, forwardAgent);
  if (!preconditionResult.ok) {
    return err(preconditionResult.error);
  }

  const { config, current, sshContext, key } = preconditionResult.value;

  try {
    // Start the interactive SSH session. This blocks until the user exits.
    const sshStartResult = await startInteractiveSsh(sshContext, key, forwardAgent);
    if (!sshStartResult.ok) {
      return err(sshStartResult.error);
    }

    // Record the connection timestamp for usage tracking / idle detection.
    // Why: downstream tooling (e.g., auto-stop) uses this to determine idle boxes.
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
          "connect session started but lastConnectAt update failed",
          commitResult.error.details,
        ),
      );
    }

    return ok({
      stdoutLines: [],
      stderrLines: [],
      ...(sshStartResult.value === 0 ? {} : { exitCode: sshStartResult.value }),
    });
  } finally {
    // Cleanup is unconditional — keys must be removed regardless of success/failure.
    // Cleanup failures are swallowed: they must not mask a transport or consistency error.
    try {
      await cleanupLocalTempKeys(key);
    } catch {
      // Best-effort: the bounded remote cleanup (15s background job) remains active
      // even if local file removal fails.
    }
  }
}
