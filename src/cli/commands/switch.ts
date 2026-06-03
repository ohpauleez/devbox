import { commitConfig, loadConfig } from "../../adapters/config-store.js";
import { parseAlias } from "../../domain/alias.js";
import { makeError } from "../../domain/errors.js";
import { ok, err } from "../../domain/result.js";
import type { CommandResult } from "../context.js";

/**
 * Execute local current-alias switch.
 *
 * @param aliasRaw target alias input
 * @returns success message or normalized failure
 */
export async function runSwitchCommand(aliasRaw: string): Promise<CommandResult> {
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

  const nextConfig = {
    ...configResult.value,
    current: parsedAlias.value,
  };
  const commitResult = await commitConfig(nextConfig);
  if (!commitResult.ok) {
    return err(commitResult.error);
  }

  return ok({
    stdoutLines: [parsedAlias.value],
    stderrLines: [],
  });
}
