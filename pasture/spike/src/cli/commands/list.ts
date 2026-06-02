import { describeInstances } from "../../adapters/aws-cli.js";
import { readConfigForList } from "../../adapters/config-store.js";
import { printListTable, printNoBoxes } from "../../domain/output-contracts.js";
import { DevboxError } from "../../domain/errors.js";

const DESCRIBE_BATCH_SIZE = 1000;

export interface ListDeps {
  readConfig: typeof readConfigForList;
  describeMany: typeof describeInstances;
  printNoBoxes: typeof printNoBoxes;
  printTable: typeof printListTable;
}

export function createListCommand(deps?: Partial<ListDeps>): () => Promise<void> {
  const d: ListDeps = {
    readConfig: deps?.readConfig ?? readConfigForList,
    describeMany: deps?.describeMany ?? describeInstances,
    printNoBoxes: deps?.printNoBoxes ?? printNoBoxes,
    printTable: deps?.printTable ?? printListTable,
  };

  return async function listCommandImpl(): Promise<void> {
    const config = await d.readConfig();
    const entries = Object.entries(config.boxes);
    if (entries.length === 0) {
      d.printNoBoxes();
      return;
    }

    const rows: Array<{
      current: boolean;
      alias: string;
      instanceId: string;
      state: string;
      instanceType: string;
    }> = [];

    const ids = entries.map(([, box]) => box.instanceId);
    let described: Map<string, { state: string; instanceType: string }> | undefined;
    try {
      described = new Map<string, { state: string; instanceType: string }>();
      for (let i = 0; i < ids.length; i += DESCRIBE_BATCH_SIZE) {
        const batch = ids.slice(i, i + DESCRIBE_BATCH_SIZE);
        const partial = await d.describeMany(batch);
        for (const [id, desc] of partial.entries()) {
          described.set(id, { state: desc.state, instanceType: desc.instanceType });
        }
      }
    } catch (err) {
      if (!(err instanceof DevboxError) || (err.code !== "AwsCliError" && err.code !== "DependencyError")) {
        throw err;
      }
      described = undefined;
    }

    for (const [alias, box] of entries) {
      if (described === undefined) {
        rows.push({
          current: config.current === alias,
          alias,
          instanceId: box.instanceId,
          state: "unknown",
          instanceType: "unknown",
        });
        continue;
      }

      const desc = described.get(box.instanceId);
      rows.push({
        current: config.current === alias,
        alias,
        instanceId: box.instanceId,
        state: desc?.state ?? "stale",
        instanceType: desc?.instanceType ?? "unknown",
      });
    }

    d.printTable(rows);
  };
}

export const listCommand = createListCommand();
