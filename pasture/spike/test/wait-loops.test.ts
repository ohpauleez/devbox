import { describe, expect, it } from "vitest";
import { waitForEc2State } from "../src/domain/ec2-wait.js";
import { waitForSsmReadiness } from "../src/domain/ssm-readiness.js";
import { createDeterministicRuntime } from "./helpers/runtime.js";

describe("wait loop contracts", () => {
  it("ec2 wait succeeds when expected state appears", async () => {
    const states = ["pending", "pending", "running"];
    const runtime = createDeterministicRuntime({ nowMs: [0, 5_000, 10_000, 10_001] });
    await expect(
      waitForEc2State("i-1", "running", {
        describe: async () => ({ instanceId: "i-1", state: states.shift() ?? "running", instanceType: "t3" }),
        runtime,
      }),
    ).resolves.toBeUndefined();
  });

  it("ec2 wait times out with details", async () => {
    const runtime = createDeterministicRuntime({ nowMs: [0, 10_000, 400_000, 400_001] });
    await expect(
      waitForEc2State("i-1", "running", {
        describe: async () => ({ instanceId: "i-1", state: "stopped", instanceType: "t3" }),
        runtime,
      }),
    ).rejects.toMatchObject({ code: "TimeoutError" });
  });

  it("ssm wait succeeds when ready appears", async () => {
    const readiness = [false, false, true];
    const runtime = createDeterministicRuntime({ nowMs: [0, 5_000, 10_000, 10_001] });
    await expect(
      waitForSsmReadiness("i-1", {
        isReady: async () => readiness.shift() ?? true,
        runtime,
      }),
    ).resolves.toBeUndefined();
  });

  it("ssm wait times out", async () => {
    const runtime = createDeterministicRuntime({ nowMs: [0, 20_000, 130_000, 130_001] });
    await expect(
      waitForSsmReadiness("i-1", {
        isReady: async () => false,
        runtime,
      }),
    ).rejects.toMatchObject({ code: "TimeoutError" });
  });
});
