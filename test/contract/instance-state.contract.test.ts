import { describe, expect, it } from "vitest";
import {
  decideUpAction,
  decideDownAction,
  type Ec2InstanceState,
} from "../../src/domain/instance-state.js";
import { traceSpec } from "../support/spec-trace.js";

describe("decideUpAction", () => {
  it("running -> no submit, no wait", () => {
    traceSpec("LIFE-UP-IDEMPOTENT");

    const result = decideUpAction("running");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.submitStart).toBe(false);
      expect(result.value.wait).toBe(false);
    }
  });

  it("pending -> no submit, wait", () => {
    traceSpec("LIFE-UP-PENDING");

    const result = decideUpAction("pending");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.submitStart).toBe(false);
      expect(result.value.wait).toBe(true);
    }
  });

  it("stopped -> submit, wait", () => {
    traceSpec("LIFE-UP-START");

    const result = decideUpAction("stopped");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.submitStart).toBe(true);
      expect(result.value.wait).toBe(true);
    }
  });

  it("stopping -> wait for stop before submit", () => {
    traceSpec("LIFE-UP-STOPPING");

    const result = decideUpAction("stopping");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.submitStart).toBe(false);
      expect(result.value.wait).toBe(true);
      expect(result.value.waitForStoppedBeforeStart).toBe(true);
    }
  });

  it.each(["shutting-down", "terminated", "unknown"] as Ec2InstanceState[])(
    "%s -> error",
    (state) => {
      traceSpec("LIFE-UP-FAIL");

      const result = decideUpAction(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("InstanceStateError");
    },
  );
});

describe("decideDownAction", () => {
  it("stopped -> no submit, no wait", () => {
    traceSpec("LIFE-DOWN-IDEMPOTENT");

    const result = decideDownAction("stopped");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.submitStop).toBe(false);
      expect(result.value.wait).toBe(false);
    }
  });

  it("stopping -> no submit, wait", () => {
    traceSpec("LIFE-DOWN-STOPPING");

    const result = decideDownAction("stopping");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.submitStop).toBe(false);
      expect(result.value.wait).toBe(true);
    }
  });

  it("running -> submit, wait", () => {
    traceSpec("LIFE-DOWN-STOP");

    const result = decideDownAction("running");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.submitStop).toBe(true);
      expect(result.value.wait).toBe(true);
    }
  });

  it.each(["shutting-down", "terminated", "pending", "unknown"] as Ec2InstanceState[])(
    "%s -> error",
    (state) => {
      traceSpec("LIFE-DOWN-FAIL");

      const result = decideDownAction(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("InstanceStateError");
    },
  );
});
