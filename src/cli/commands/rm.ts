import { terminateInstance } from "../../adapters/aws-cli.js";
import { commitConfig, loadConfig } from "../../adapters/config-store.js";
import { parseAlias } from "../../domain/alias.js";
import { makeError } from "../../domain/errors.js";
import { err, ok } from "../../domain/result.js";
import type { BoxAlias, BoxConfig, DevboxConfig } from "../../domain/types.js";
import type { CommandResult } from "../context.js";

function removeAlias(
  boxes: Readonly<Record<BoxAlias, BoxConfig>>,
  targetAlias: BoxAlias,
): Readonly<Record<BoxAlias, BoxConfig>> {
  const nextEntries = Object.entries(boxes).filter(([alias]) => alias !== targetAlias);
  const nextBoxes: Record<BoxAlias, BoxConfig> = {};
  for (const [alias, box] of nextEntries) {
    nextBoxes[alias as BoxAlias] = box;
  }
  return nextBoxes;
}

/**
 * Execute local-only alias removal without AWS termination.
 *
 * @param aliasRaw - alias to remove from local tracking
 * @returns alias in stdout with a warning about orphaned AWS resources
 *
 * @remarks
 * Precondition: `aliasRaw` must be a valid, currently-tracked alias.
 * Postcondition: on success, the alias is removed from config; if it was current, current is cleared.
 * Failures: `ValidationError` for invalid or untracked alias; `ConfigError` for persistence failures.
 */
export async function runLocalRemoveCommand(aliasRaw: string): Promise<CommandResult> {
  const parsedAlias = parseAlias(aliasRaw);
  if (!parsedAlias.ok) {
    return err(parsedAlias.error);
  }

  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  if (!(parsedAlias.value in configResult.value.boxes)) {
    return err(makeError("ValidationError", `alias is not tracked: ${parsedAlias.value}`));
  }

  const nextBoxes = removeAlias(configResult.value.boxes, parsedAlias.value);
  const nextCurrent =
    configResult.value.current === parsedAlias.value ? undefined : configResult.value.current;

  const nextConfig: DevboxConfig = {
    boxes: nextBoxes,
    defaults: configResult.value.defaults,
    ...(nextCurrent !== undefined ? { current: nextCurrent } : {}),
  };

  const commitResult = await commitConfig(nextConfig);
  if (!commitResult.ok) {
    return err(commitResult.error);
  }

  return ok({
    stdoutLines: [parsedAlias.value],
    stderrLines: [
      "[devbox] Warning: alias removed locally; associated AWS resources may still exist.",
    ],
  });
}

/**
 * Execute alias removal with explicit AWS instance termination.
 *
 * @param aliasRaw - alias to remove and whose instance to terminate
 * @returns alias in stdout on success
 *
 * @remarks
 * Precondition: `aliasRaw` must be a valid, currently-tracked alias.
 * Postcondition: on success, the AWS instance is terminated and the alias is removed from config.
 * Failures: `ValidationError` for invalid/untracked alias; `AwsCliError`/`DependencyError` for termination failures;
 * `ConsistencyError` when termination succeeds but config persistence fails.
 */
export async function runTerminateRemoveCommand(aliasRaw: string): Promise<CommandResult> {
  const parsedAlias = parseAlias(aliasRaw);
  if (!parsedAlias.ok) {
    return err(parsedAlias.error);
  }

  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const tracked = configResult.value.boxes[parsedAlias.value];
  if (tracked === undefined) {
    return err(makeError("ValidationError", `alias is not tracked: ${parsedAlias.value}`));
  }

  const terminateResult = await terminateInstance(tracked.instanceId);
  if (!terminateResult.ok) {
    return err(terminateResult.error);
  }

  const nextBoxes = removeAlias(configResult.value.boxes, parsedAlias.value);
  const nextCurrent =
    configResult.value.current === parsedAlias.value ? undefined : configResult.value.current;
  const nextConfig: DevboxConfig = {
    boxes: nextBoxes,
    defaults: configResult.value.defaults,
    ...(nextCurrent !== undefined ? { current: nextCurrent } : {}),
  };

  const commitResult = await commitConfig(nextConfig);
  if (!commitResult.ok) {
    return err(
      makeError(
        "ConsistencyError",
        `AWS termination accepted for ${tracked.instanceId} but local tracking update failed`,
        commitResult.error.details,
      ),
    );
  }

  return ok({
    stdoutLines: [parsedAlias.value],
    stderrLines: [],
  });
}
