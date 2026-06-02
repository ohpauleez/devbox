import { mutateConfig, readConfigForList } from "../../adapters/config-store.js";
import { terminateInstance } from "../../adapters/aws-cli.js";
import { DevboxError } from "../../domain/errors.js";
import { printLine } from "../../domain/output-contracts.js";

export interface RmDeps {
  readConfig: typeof readConfigForList;
  mutateConfig: typeof mutateConfig;
  terminate: typeof terminateInstance;
  warn: (s: string) => void;
  print: typeof printLine;
}

export function createRmCommand(deps?: Partial<RmDeps>): (alias: string, terminate: boolean) => Promise<void> {
  const d: RmDeps = {
    readConfig: deps?.readConfig ?? readConfigForList,
    mutateConfig: deps?.mutateConfig ?? mutateConfig,
    terminate: deps?.terminate ?? terminateInstance,
    warn: deps?.warn ?? ((s) => process.stderr.write(s)),
    print: deps?.print ?? printLine,
  };

  return async function rmCommandImpl(alias: string, terminate: boolean): Promise<void> {
    const cfg = await d.readConfig();
    const box = cfg.boxes[alias];
    if (!box) {
      throw new DevboxError("NotFoundError", `Alias not found: ${alias}`);
    }

    if (terminate) {
      await d.terminate(box.instanceId);
    } else {
      d.warn("Warning: local alias removed; AWS resources may still exist\n");
    }

    await d.mutateConfig((current) => {
      if (!current.boxes[alias]) {
        throw new DevboxError("NotFoundError", `Alias not found: ${alias}`);
      }
      const nextBoxes = { ...current.boxes };
      delete nextBoxes[alias];

      return {
        ...current,
        boxes: nextBoxes,
        current: current.current === alias ? undefined : current.current,
      };
    });

    d.print(alias);
  };
}

export const rmCommand = createRmCommand();
