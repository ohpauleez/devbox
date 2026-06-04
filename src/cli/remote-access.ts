/**
 * @module remote-access
 *
 * Shared precondition resolution for commands that require remote access to a devbox
 * instance (e.g., `connect`, `cp`). This module encapsulates the full precondition
 * chain that must succeed before any SSH transport can begin:
 *
 * 1. Load configuration (establishes local state is valid)
 * 2. Resolve current box alias (ensures a target is selected)
 * 3. Resolve SSH user (merges defaults, box config, and invocation override)
 * 4. Describe instance (verifies instance exists in AWS)
 * 5. Verify running state (transport requires a running instance)
 * 6. Wait for SSM online (SSH-over-SSM requires the agent to be responsive)
 * 7. Ensure SSH key material (local key pair must exist)
 * 8. Stage temporary SSH key (push public key via SSM for short-lived access)
 *
 * Each step depends on the output of the previous step, enforcing a strict
 * sequential ordering. Failure at any point short-circuits with a typed error.
 *
 * @example
 * ```ts
 * const ctx = await resolveRemoteAccessPreconditions("ubuntu");
 * if (!ctx.ok) { handleError(ctx.error); return; }
 * // ctx.value.key, ctx.value.sshContext are ready for transport
 * ```
 */

import { describeInstance, describeSsmPingStatus } from "../../adapters/aws-cli.js";
import { loadConfig } from "../../adapters/config-store.js";
import { ensureSshKeyMaterial, stageTemporarySshKey, type SshContext, type StagedKey } from "../../adapters/ssh-cli.js";
import { resolveCurrentBox, type CurrentBox } from "../../domain/context.js";
import { waitForSsmOnline } from "../../domain/ec2-wait.js";
import { makeError, type DevboxError } from "../../domain/errors.js";
import { resolveSshUser } from "../../domain/ssh-user.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { DevboxConfig, SshUser } from "../../domain/types.js";

/**
 * Fully resolved remote-access context after all preconditions are satisfied.
 *
 * @remarks
 * Invariant: if this value exists, the instance is confirmed running, SSM is online,
 * and `key` is staged for immediate SSH transport. Callers must clean up `key` after use.
 *
 * Ownership: the caller owns `key` and is responsible for invoking `cleanupLocalTempKeys`
 * in all exit paths (including signal interruption).
 */
export interface RemoteAccessContext {
  readonly config: DevboxConfig;
  readonly current: CurrentBox;
  readonly sshUser: SshUser;
  readonly sshContext: SshContext;
  readonly key: StagedKey;
}

/**
 * Execute the shared remote-access precondition chain:
 * load config → resolve current → resolve SSH user → describe instance →
 * verify running state → wait SSM online → ensure key material → stage key.
 *
 * @param invocationSshUser - Optional CLI-level SSH user override. When provided,
 *   takes precedence over box-level and default-level SSH user configuration.
 *
 * @returns On success: a {@link RemoteAccessContext} with all fields populated and
 *   the instance confirmed running with a staged SSH key. On error: a typed
 *   {@link DevboxError} indicating which precondition failed.
 *
 * @remarks
 * Preconditions:
 * - AWS CLI must be installed and configured with valid credentials.
 * - `ssh-keygen` or `ssh-agent` must be available on PATH.
 * - A valid devbox config file must exist locally.
 *
 * Postconditions on success:
 * - Instance is confirmed in "running" state.
 * - SSM agent is online and responsive.
 * - SSH public key is staged on the remote instance (time-limited).
 *
 * Invariants: no side-effects occur if any step fails (each step is checked
 * before proceeding to the next).
 *
 * Failure forms:
 * - `ConfigError` — config file missing or malformed.
 * - `ValidationError` — no current box set, or invalid SSH user override.
 * - `NotFoundError` — instance does not exist in AWS.
 * - `InstanceStateError` — instance is not in "running" state.
 * - `TimeoutError` — SSM agent did not come online within polling budget.
 * - `DependencyError` — ssh-keygen/ssh-agent unavailable or key generation failed.
 * - `TransportError` — key staging via SSM SendCommand failed.
 *
 * Concurrency: not safe to call concurrently for the same instance (key staging
 * is not idempotent within the TTL window).
 *
 * @example
 * ```ts
 * import { resolveRemoteAccessPreconditions } from "./remote-access.js";
 *
 * const result = await resolveRemoteAccessPreconditions();
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   process.exit(1);
 * }
 * // result.value.sshContext and result.value.key are ready for SSH/SCP
 * ```
 */
export async function resolveRemoteAccessPreconditions(
  invocationSshUser?: string,
): Promise<Result<RemoteAccessContext, DevboxError>> {
  // Step 1: Load config — all subsequent steps depend on having valid local state.
  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  // Step 2: Resolve the current box alias → instance mapping.
  // Why: we need an instance ID before we can query AWS.
  const currentResult = resolveCurrentBox(configResult.value);
  if (!currentResult.ok) {
    return err(currentResult.error);
  }

  // Step 3: Resolve the SSH user from the layered config hierarchy.
  // Why: the SSH user determines the remote authorized_keys target and must be
  // resolved before we interact with the instance (used in key staging).
  const sshUserResult = resolveSshUser({
    box: currentResult.value.box,
    defaults: configResult.value.defaults,
    ...(invocationSshUser !== undefined ? { invocationOverride: invocationSshUser } : {}),
  });
  if (!sshUserResult.ok) {
    return err(sshUserResult.error);
  }

  // Step 4: Describe the instance to confirm it exists and get current state.
  // Why: starting SSH against a terminated or non-existent instance wastes time
  // and produces confusing errors; we fail fast with a clear message instead.
  const instanceResult = await describeInstance(currentResult.value.box.instanceId);
  if (!instanceResult.ok) {
    return err(instanceResult.error);
  }
  if (instanceResult.value.state !== "running") {
    return err(makeError("InstanceStateError", `remote access requires running instance (found ${instanceResult.value.state})`));
  }

  // Step 5: Wait for SSM agent to be online.
  // Why: even a "running" instance may not have SSM ready yet (e.g., just started).
  // Key staging uses SSM SendCommand, so SSM must be responsive first.
  const ssmWaitResult = await waitForSsmOnline(() =>
    describeSsmPingStatus(instanceResult.value.instanceId),
  );
  if (!ssmWaitResult.ok) {
    return err(ssmWaitResult.error);
  }

  // Step 6: Ensure local SSH key material exists (generate if needed).
  // Why: we need a public key to stage on the remote. This must happen before
  // staging so we have the key content to push.
  const keyResult = await ensureSshKeyMaterial();
  if (!keyResult.ok) {
    return err(keyResult.error);
  }

  const sshContext: SshContext = {
    instanceId: instanceResult.value.instanceId,
    sshUser: sshUserResult.value,
  };

  // Step 7: Stage the public key on the remote instance via SSM.
  // Why: this is the final precondition — after this, SSH transport can proceed
  // because the remote authorized_keys file contains our ephemeral public key.
  const stageResult = await stageTemporarySshKey(sshContext, keyResult.value);
  if (!stageResult.ok) {
    return err(stageResult.error);
  }

  return ok({
    config: configResult.value,
    current: currentResult.value,
    sshUser: sshUserResult.value,
    sshContext,
    key: keyResult.value,
  });
}
