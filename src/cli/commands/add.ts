import { describeInstance } from "../../adapters/aws-cli.js";
import { commitConfig, loadConfig } from "../../adapters/config-store.js";
import { ensureAliasAvailable, matchesInstanceIdAdvisoryPattern, parseAlias } from "../../domain/alias.js";
import { makeError } from "../../domain/errors.js";
import { err, ok } from "../../domain/result.js";
import type { DevboxConfig, InstanceId } from "../../domain/types.js";
import type { CommandResult } from "../context.js";

/**
 * Track an existing EC2 instance and set current alias.
 *
 * @param instanceIdRaw EC2 instance id provided by user
 * @param aliasRaw local alias to track
 * @returns success output or normalized failure
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
