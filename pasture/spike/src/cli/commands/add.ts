import { describeInstance } from "../../adapters/aws-cli.js";
import { mutateConfig } from "../../adapters/config-store.js";
import { validateAlias, warnIfInstanceIdOdd } from "../../domain/alias.js";
import { DevboxError } from "../../domain/errors.js";
import { printLine } from "../../domain/output-contracts.js";

export interface AddDeps {
  validateAlias: typeof validateAlias;
  warnIfInstanceIdOdd: typeof warnIfInstanceIdOdd;
  describe: typeof describeInstance;
  mutateConfig: typeof mutateConfig;
  print: typeof printLine;
}

export function createAddCommand(deps?: Partial<AddDeps>): (instanceId: string, alias: string) => Promise<void> {
  const d: AddDeps = {
    validateAlias: deps?.validateAlias ?? validateAlias,
    warnIfInstanceIdOdd: deps?.warnIfInstanceIdOdd ?? warnIfInstanceIdOdd,
    describe: deps?.describe ?? describeInstance,
    mutateConfig: deps?.mutateConfig ?? mutateConfig,
    print: deps?.print ?? printLine,
  };

  return async function addCommandImpl(instanceId: string, alias: string): Promise<void> {
    d.validateAlias(alias);
    d.warnIfInstanceIdOdd(instanceId);
    await d.describe(instanceId);

    await d.mutateConfig((cfg) => {
      if (cfg.boxes[alias]) {
        throw new DevboxError("ValidationError", `Alias already exists: ${alias}`);
      }
      return {
        ...cfg,
        boxes: {
          ...cfg.boxes,
          [alias]: {
            instanceId,
          },
        },
        current: cfg.current ?? alias,
      };
    });

    d.print(instanceId);
  };
}

export const addCommand = createAddCommand();
