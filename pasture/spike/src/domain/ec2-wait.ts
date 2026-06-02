import { describeInstance } from "../adapters/aws-cli.js";
import { DevboxError } from "./errors.js";
import { EC2_POLL_INTERVAL_MS, EC2_WAIT_TIMEOUT_MS } from "./wait-policy.js";
import { Runtime, realRuntime } from "./runtime.js";

export async function waitForEc2State(
  instanceId: string,
  expected: "running" | "stopped",
  deps?: {
    describe?: typeof describeInstance;
    runtime?: Runtime;
  },
): Promise<void> {
  const describe = deps?.describe ?? describeInstance;
  const runtime = deps?.runtime ?? realRuntime;
  const started = runtime.nowMs();
  let lastObserved = "unknown";

  while (runtime.nowMs() - started <= EC2_WAIT_TIMEOUT_MS) {
    const described = await describe(instanceId);
    lastObserved = described.state;
    if (described.state === expected) {
      return;
    }
    await runtime.sleep(EC2_POLL_INTERVAL_MS);
  }

  throw new DevboxError(
    "TimeoutError",
    `Timed out waiting for ${expected}: ${instanceId}`,
    `expected=${expected} last=${lastObserved} elapsedMs=${runtime.nowMs() - started}`,
  );
}
