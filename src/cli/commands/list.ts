import { loadConfig } from "../../adapters/config-store.js";
import { describeInstances } from "../../adapters/aws-cli.js";
import {
  renderListTable,
  renderNoBoxesTracked,
  type ListRow,
} from "../../domain/output-contracts.js";
import { err, ok } from "../../domain/result.js";
import type { CommandResult } from "../context.js";

/**
 * Execute local registry listing.
 *
 * @returns list command output or ConfigError
 */
export async function runListCommand(): Promise<CommandResult> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const entries = Object.entries(configResult.value.boxes);
  if (entries.length === 0) {
    return ok(renderNoBoxesTracked());
  }

  const sortedEntries = [...entries].sort(([left], [right]) => left.localeCompare(right));

  const rows: ListRow[] = [];
  let describedById: ReadonlyMap<string, { readonly state: string; readonly instanceType: string }> | undefined;
  const instanceIds = sortedEntries.map(([, box]) => box.instanceId);
  const describeResult = await describeInstances(instanceIds);
  if (describeResult.ok) {
    describedById = describeResult.value;
  } else if (
    describeResult.error.category !== "DependencyError" &&
    describeResult.error.category !== "AwsCliError"
  ) {
    return err(describeResult.error);
  }

  for (const [alias, box] of sortedEntries) {
    const described = describedById?.get(box.instanceId);
    rows.push({
      isCurrent: configResult.value.current === alias,
      alias,
      instanceId: box.instanceId,
      instanceType: described?.instanceType ?? "unknown",
      state:
        describedById === undefined
          ? "unknown"
          : described?.state ?? "stale",
    });
  }

  return ok(renderListTable(rows));
}
