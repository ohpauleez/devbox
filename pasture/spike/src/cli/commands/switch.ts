import { mutateConfig } from "../../adapters/config-store.js";
import { printLine } from "../../domain/output-contracts.js";
import { requireAlias } from "../../domain/context.js";

export interface SwitchDeps {
  mutateConfig: typeof mutateConfig;
  print: typeof printLine;
}

export function createSwitchCommand(deps?: Partial<SwitchDeps>): (alias: string) => Promise<void> {
  const d: SwitchDeps = {
    mutateConfig: deps?.mutateConfig ?? mutateConfig,
    print: deps?.print ?? printLine,
  };

  return async function switchCommandImpl(alias: string): Promise<void> {
    await d.mutateConfig((cfg) => {
      requireAlias(cfg, alias);
      return {
        ...cfg,
        current: alias,
      };
    });
    d.print(alias);
  };
}

export const switchCommand = createSwitchCommand();
