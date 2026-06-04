/**
 * @module init
 *
 * Implements the `init` command: launch a new EC2 instance from a JSON template
 * and register it under a local alias in the devbox configuration.
 *
 * The flow proceeds as:
 * 1. Validate and parse the alias.
 * 2. Load existing config and verify alias is unused.
 * 3. Read and parse the JSON template file.
 * 4. Map template + defaults into an AWS `run-instances` request.
 * 5. Launch the instance via AWS CLI.
 * 6. Persist the new box entry and set it as current.
 *
 * A critical safety concern: if the instance launches successfully but config
 * persistence fails, the instance exists in AWS but is not tracked locally.
 * This is surfaced as a `ConsistencyError` so the user can manually recover.
 *
 * @example
 * ```ts
 * const result = await runInitCommand("mybox", "./template.json");
 * if (result.ok) {
 *   console.log(`Launched: ${result.value.stdoutLines[0]}`);
 * }
 * ```
 */

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
 * Launch a new EC2 instance from a JSON template file and track it under a local alias.
 *
 * @param aliasRaw - Target local alias for the new box. Must match the alias pattern
 *   (alphanumeric + hyphens) and must not already be in use.
 * @param templateFile - Absolute or relative path to a JSON file conforming to the
 *   `run-instances` template schema.
 *
 * @returns On success: the launched instance ID in `stdoutLines[0]`.
 *   On error: a typed {@link DevboxError} describing what failed.
 *
 * @throws Never throws — all failures are returned as `Result.err`.
 *
 * @remarks
 * Preconditions:
 * - `aliasRaw` must be a syntactically valid, currently-unused alias.
 * - `templateFile` must be a readable file containing valid JSON.
 * - AWS CLI must be configured with credentials that allow `ec2 run-instances`.
 *
 * Postconditions on success:
 * - An EC2 instance has been launched with the specified parameters.
 * - The local config file contains the new box entry with its instance ID.
 * - The new alias is set as the current box.
 *
 * Invariants:
 * - No instance is launched if alias validation or template parsing fails.
 * - If launch succeeds but config write fails, a `ConsistencyError` is returned
 *   (the instance still exists in AWS and must be cleaned up manually).
 *
 * Failure forms:
 * - `ValidationError` — invalid alias pattern, alias already taken, unreadable
 *   template file, or template fails schema mapping.
 * - `AwsCliError` / `DependencyError` — `run-instances` call failed.
 * - `ConfigError` — config file could not be loaded.
 * - `ConsistencyError` — instance launched but config persistence failed.
 *
 * Ordering: alias validation happens before any AWS interaction to avoid
 * launching instances that cannot be tracked.
 *
 * @example
 * ```ts
 * import { runInitCommand } from "./init.js";
 *
 * const result = await runInitCommand("dev-server", "/path/to/template.json");
 * if (!result.ok) {
 *   // result.error.tag indicates the failure category
 *   process.exit(1);
 * }
 * console.log(`Instance ${result.value.stdoutLines[0]} is launching`);
 * ```
 */
export async function runInitCommand(aliasRaw: string, templateFile: string): Promise<CommandResult> {
  // Step 1: Parse and validate the alias format before any I/O.
  // Why: reject obviously invalid input immediately to avoid wasted work.
  const parsedAlias = parseAlias(aliasRaw);
  if (!parsedAlias.ok) {
    return err(parsedAlias.error);
  }

  // Step 2: Load config to check alias availability and retrieve defaults.
  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  // Step 3: Verify the alias is not already taken.
  // Why: launching an instance under a duplicate alias would silently overwrite
  // the existing box entry, orphaning the previous instance.
  const aliasAvailability = ensureAliasAvailable(parsedAlias.value, configResult.value.boxes);
  if (!aliasAvailability.ok) {
    return err(aliasAvailability.error);
  }

  // Step 4: Read and parse the template file.
  // Why: we validate the template before calling AWS to avoid partial failures.
  let templateJson: unknown;
  try {
    const raw = await readFile(templateFile, "utf8");
    templateJson = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    return err(makeError("ValidationError", `failed to read or parse template file: ${templateFile}`, [`${error}`]));
  }

  // Step 5: Map the raw template JSON + config defaults into a validated request.
  // Why: the mapper enforces schema constraints and merges default values
  // (e.g., security groups, key name) so the launch request is complete.
  const mappedRequest = mapInitTemplateToRunInstances(
    parsedAlias.value,
    templateJson,
    configResult.value.defaults,
  );
  if (!mappedRequest.ok) {
    return err(mappedRequest.error);
  }

  // Step 6: Launch the instance via AWS CLI.
  const launchResult = await runInstances(mappedRequest.value);
  if (!launchResult.ok) {
    return err(launchResult.error);
  }

  // Step 7: Persist the new box into config and set as current.
  // Why: the instance is now running in AWS; we must track it locally or the
  // user loses the ability to manage it through devbox.
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
