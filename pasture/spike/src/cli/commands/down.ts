import { describeInstance, stopInstance } from "../../adapters/aws-cli.js";
import { readConfigForList } from "../../adapters/config-store.js";
import { requireCurrent } from "../../domain/context.js";
import { waitForEc2State } from "../../domain/ec2-wait.js";
import { assertDownPreState } from "../../domain/instance-state.js";
import { DevboxError } from "../../domain/errors.js";
import { printLine } from "../../domain/output-contracts.js";

export interface DownDeps {
  readConfig: typeof readConfigForList;
  describe: typeof describeInstance;
  stop: typeof stopInstance;
  wait: typeof waitForEc2State;
  print: typeof printLine;
}

export function createDownCommand(deps?: Partial<DownDeps>): () => Promise<void> {
  const d: DownDeps = {
    readConfig: deps?.readConfig ?? readConfigForList,
    describe: deps?.describe ?? describeInstance,
    stop: deps?.stop ?? stopInstance,
    wait: deps?.wait ?? waitForEc2State,
    print: deps?.print ?? printLine,
  };

  return async function downCommandImpl(): Promise<void> {
    const cfg = await d.readConfig();
    const { instanceId } = requireCurrent(cfg);
    const desc = await d.describe(instanceId);
    assertDownPreState(desc.state, instanceId);

    if (desc.state === "stopped") {
      d.print(instanceId);
      return;
    }
    if (desc.state === "running") {
      await d.stop(instanceId);
    }
    if (desc.state === "running" || desc.state === "stopping") {
      await d.wait(instanceId, "stopped");
      d.print(instanceId);
      return;
    }

    throw new DevboxError(
      "InstanceStateError",
      `Cannot run down from state '${desc.state}' for ${instanceId}`,
    );
  };
}

export const downCommand = createDownCommand();
