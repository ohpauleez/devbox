import { describeInstance, startInstance } from "../../adapters/aws-cli.js";
import { readConfigForList } from "../../adapters/config-store.js";
import { requireCurrent } from "../../domain/context.js";
import { waitForEc2State } from "../../domain/ec2-wait.js";
import { assertUpPreState } from "../../domain/instance-state.js";
import { DevboxError } from "../../domain/errors.js";
import { printLine } from "../../domain/output-contracts.js";

export interface UpDeps {
  readConfig: typeof readConfigForList;
  describe: typeof describeInstance;
  start: typeof startInstance;
  wait: typeof waitForEc2State;
  print: typeof printLine;
}

export function createUpCommand(deps?: Partial<UpDeps>): () => Promise<void> {
  const d: UpDeps = {
    readConfig: deps?.readConfig ?? readConfigForList,
    describe: deps?.describe ?? describeInstance,
    start: deps?.start ?? startInstance,
    wait: deps?.wait ?? waitForEc2State,
    print: deps?.print ?? printLine,
  };

  return async function upCommandImpl(): Promise<void> {
    const cfg = await d.readConfig();
    const { instanceId } = requireCurrent(cfg);
    const desc = await d.describe(instanceId);
    assertUpPreState(desc.state, instanceId);

    if (desc.state === "running") {
      d.print(instanceId);
      return;
    }
    if (desc.state === "stopped") {
      await d.start(instanceId);
    }
    if (desc.state === "stopped" || desc.state === "pending") {
      await d.wait(instanceId, "running");
      d.print(instanceId);
      return;
    }

    throw new DevboxError(
      "InstanceStateError",
      `Cannot run up from state '${desc.state}' for ${instanceId}`,
    );
  };
}

export const upCommand = createUpCommand();
