import { describeInstance } from "../../adapters/aws-cli.js";
import { commitConfig, loadConfig } from "../../adapters/config-store.js";
import { ensureAliasAvailable, matchesInstanceIdAdvisoryPattern, parseAlias } from "../../domain/alias.js";
import { err, ok } from "../../domain/result.js";
import type { DevboxConfig, InstanceId } from "../../domain/types.js";
import type { CommandResult } from "../context.js";

/**
 * Track an existing EC2 instance under a local alias and set it as current.
 *
 * @param instanceIdRaw - EC2 instance id provided by user (verified against AWS)
 * @param aliasRaw - local alias to assign (must be unique and pattern-valid)
 * @returns instance id in stdout on success (with advisory warning if id format is unusual)
 *
 * @remarks
 * Precondition: `aliasRaw` must be valid and unused; `instanceIdRaw` must reference an existing instance.
 * Postcondition: on success, the instance is tracked under the alias and set as current.
 * Failures: `ValidationError` for invalid/duplicate alias; `NotFoundError`/`AwsCliError`/`DependencyError`
 * for AWS verification failures; `ConfigError` for persistence failures.
 */
export async function runAddCommand(instanceIdRaw: string, aliasRaw: string): Promise<CommandResult> {
  const parsedAlias = parseAlias(aliasRaw);
  if (!parsedAlias.ok) {
    return err(parsedAlias.error);
  }

  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const aliasAvailability = ensureAliasAvailable(parsedAlias.value, configResult.value.boxes);
  if (!aliasAvailability.ok) {
    return err(aliasAvailability.error);
  }

  const describeResult = await describeInstance(instanceIdRaw);
  if (!describeResult.ok) {
    return err(describeResult.error);
  }

  const warningLines: string[] = [];
  if (!matchesInstanceIdAdvisoryPattern(instanceIdRaw)) {
    warningLines.push(
      `[devbox] Warning: instance id does not match advisory EC2 pattern: ${instanceIdRaw}`,
    );
  }

  const nextConfig: DevboxConfig = {
    ...configResult.value,
    boxes: {
      ...configResult.value.boxes,
      [parsedAlias.value]: {
        instanceId: describeResult.value.instanceId as InstanceId,
      },
    },
    current: parsedAlias.value,
  };

  const commitResult = await commitConfig(nextConfig);
  if (!commitResult.ok) {
    return err(commitResult.error);
  }

  return ok({
    stdoutLines: [describeResult.value.instanceId],
    stderrLines: warningLines,
  });
}
