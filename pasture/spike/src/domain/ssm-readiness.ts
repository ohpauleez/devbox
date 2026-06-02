import { ssmReady } from "../adapters/aws-cli.js";
import { SSM_POLL_INTERVAL_MS, SSM_WAIT_TIMEOUT_MS } from "./wait-policy.js";
import { DevboxError } from "./errors.js";
import { Runtime, realRuntime } from "./runtime.js";

export async function waitForSsmReadiness(
  instanceId: string,
  deps?: {
    isReady?: typeof ssmReady;
    runtime?: Runtime;
  },
): Promise<void> {
  const isReady = deps?.isReady ?? ssmReady;
  const runtime = deps?.runtime ?? realRuntime;
  const started = runtime.nowMs();
  while (runtime.nowMs() - started <= SSM_WAIT_TIMEOUT_MS) {
    const ready = await isReady(instanceId);
    if (ready) {
      return;
    }
    await runtime.sleep(SSM_POLL_INTERVAL_MS);
  }
  throw new DevboxError(
    "TimeoutError",
    `Timed out waiting for SSM readiness: ${instanceId}`,
  );
}
