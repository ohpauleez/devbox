import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { decideUpAction, decideDownAction } from "../../src/domain/instance-state.js";
import type { Ec2InstanceState } from "../../src/domain/instance-state.js";
import { waitForEc2TargetState, type DescribeInstanceFn } from "../../src/domain/ec2-wait.js";
import type { InstanceDescription } from "../../src/adapters/aws-cli.js";
import { ok } from "../../src/domain/result.js";

const ALL_STATES: Ec2InstanceState[] = [
  "pending",
  "running",
  "shutting-down",
  "terminated",
  "stopping",
  "stopped",
  "unknown",
];

const upOkStates: Ec2InstanceState[] = ["running", "pending", "stopped"];
const upErrStates: Ec2InstanceState[] = ["shutting-down", "terminated", "stopping", "unknown"];
const downOkStates: Ec2InstanceState[] = ["stopped", "stopping", "running"];
const downErrStates: Ec2InstanceState[] = ["shutting-down", "terminated", "pending", "unknown"];

describe("decideUpAction", () => {
  it("returns ok with targetState=running for running/pending/stopped", () => {
    fc.assert(
      fc.property(fc.constantFrom(...upOkStates), (state) => {
        const result = decideUpAction(state);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.targetState).toBe("running");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("returns err for shutting-down/terminated/stopping/unknown", () => {
    fc.assert(
      fc.property(fc.constantFrom(...upErrStates), (state) => {
        const result = decideUpAction(state);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("decideDownAction", () => {
  it("returns ok with targetState=stopped for stopped/stopping/running", () => {
    fc.assert(
      fc.property(fc.constantFrom(...downOkStates), (state) => {
        const result = decideDownAction(state);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.targetState).toBe("stopped");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("returns err for shutting-down/terminated/pending/unknown", () => {
    fc.assert(
      fc.property(fc.constantFrom(...downErrStates), (state) => {
        const result = decideDownAction(state);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("waitForEc2TargetState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds when target state appears in trace", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...ALL_STATES.filter((s) => s !== "running")), {
          minLength: 0,
          maxLength: 4,
        }),
        async (prefix) => {
          const trace: Ec2InstanceState[] = [...prefix, "running"];
          let callIndex = 0;

          const describeFn: DescribeInstanceFn = async (_id) => {
            const state = trace[callIndex] ?? "running";
            callIndex++;
            const desc: InstanceDescription = { instanceId: "i-abc", state, instanceType: "t3.micro" };
            return ok(desc);
          };

          const promise = waitForEc2TargetState(
            { instanceId: "i-abc", expectedState: "running" },
            describeFn,
          );

          // Advance timers enough for all polls
          for (let i = 0; i < trace.length + 1; i++) {
            await vi.advanceTimersByTimeAsync(6000);
          }

          const result = await promise;
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.lastObservedState).toBe("running");
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
