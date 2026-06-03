import { readFile } from "node:fs/promises";

import { runInstances } from "../../adapters/aws-cli.js";
import { commitConfig, loadConfig } from "../../adapters/config-store.js";
import { ensureAliasAvailable, parseAlias } from "../../domain/alias.js";
import { makeError } from "../../domain/errors.js";
import { mapInitTemplateToRunInstances } from "../../domain/init-mapper.js";
import { err, ok } from "../../domain/result.js";
import type { DevboxConfig, InstanceId } from "../../domain/types.js";
import type { CommandResult } from "../context.js";

/**
 * Launch a new EC2 instance from a template and track it.
 *
 * @param aliasRaw target local alias
 * @param templateFile template file path
 * @returns instance id on success or normalized error
 */
export async function runInitCommand(aliasRaw: string, templateFile: string): Promise<CommandResult> {
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

  let templateJson: unknown;
  try {
    const raw = await readFile(templateFile, "utf8");
    templateJson = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    return err(makeError("ValidationError", `failed to read or parse template file: ${templateFile}`, [`${error}`]));
  }

  const mappedRequest = mapInitTemplateToRunInstances(
    parsedAlias.value,
    templateJson,
    configResult.value.defaults,
  );
  if (!mappedRequest.ok) {
    return err(mappedRequest.error);
  }

  const launchResult = await runInstances(mappedRequest.value);
  if (!launchResult.ok) {
    return err(launchResult.error);
  }

  const nextConfig: DevboxConfig = {
    ...configResult.value,
    boxes: {
      ...configResult.value.boxes,
      [parsedAlias.value]: { instanceId: launchResult.value.instanceId as InstanceId },
    },
    current: parsedAlias.value,
  };
  const commitResult = await commitConfig(nextConfig);
  if (!commitResult.ok) {
    return err(
      makeError(
        "ConsistencyError",
        `instance launched (${launchResult.value.instanceId}) but config write failed`,
        commitResult.error.details,
      ),
    );
  }

  return ok({
    stdoutLines: [launchResult.value.instanceId],
    stderrLines: [],
  });
}
