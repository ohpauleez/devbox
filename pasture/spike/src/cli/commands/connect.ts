import { readConfigForList, mutateConfig } from "../../adapters/config-store.js";
import { connectViaSsm } from "../../adapters/ssh-cli.js";
import { describeInstance } from "../../adapters/aws-cli.js";
import { requireCurrent } from "../../domain/context.js";
import { DevboxError } from "../../domain/errors.js";
import { waitForSsmReadiness } from "../../domain/ssm-readiness.js";
import { Runtime, realRuntime } from "../../domain/runtime.js";

export interface ConnectDeps {
  readConfig: typeof readConfigForList;
  mutateConfig: typeof mutateConfig;
  describe: typeof describeInstance;
  waitForSsm: typeof waitForSsmReadiness;
  connect: typeof connectViaSsm;
  runtime: Runtime;
}

export function createConnectCommand(deps?: Partial<ConnectDeps>): () => Promise<void> {
  const d: ConnectDeps = {
    readConfig: deps?.readConfig ?? readConfigForList,
    mutateConfig: deps?.mutateConfig ?? mutateConfig,
    describe: deps?.describe ?? describeInstance,
    waitForSsm: deps?.waitForSsm ?? waitForSsmReadiness,
    connect: deps?.connect ?? connectViaSsm,
    runtime: deps?.runtime ?? realRuntime,
  };

  return async function connectCommandImpl(): Promise<void> {
    const cfg = await d.readConfig();
    const { alias, instanceId } = requireCurrent(cfg);
    const desc = await d.describe(instanceId);
    if (desc.state !== "running") {
      throw new DevboxError("InstanceStateError", `Instance is not running: ${instanceId}`);
    }
    await d.waitForSsm(instanceId);
    await d.connect(instanceId);

    await d.mutateConfig((current) => {
      const box = current.boxes[alias];
      if (!box) {
        return current;
      }
      return {
        ...current,
        boxes: {
          ...current.boxes,
          [alias]: {
            ...box,
            lastConnectAt: d.runtime.nowIso(),
          },
        },
      };
    });
  };
}

export const connectCommand = createConnectCommand();
