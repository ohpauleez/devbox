import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  waitForEc2TargetState,
  waitForSsmOnline,
  type DescribeInstanceFn,
  type DescribeSsmStatusFn,
  type WaitEc2TargetInput,
} from "../../src/domain/ec2-wait.js";
import { ok, err } from "../../src/domain/result.js";
import { makeError } from "../../src/domain/errors.js";
import {
  EC2_WAIT_TIMEOUT_MS,
  EC2_POLL_INTERVAL_MS,
  SSM_WAIT_TIMEOUT_MS,
  SSM_POLL_INTERVAL_MS,
} from "../../src/domain/wait-policy.js";
import { traceSpec } from "../support/spec-trace.js";

describe("waitForEc2TargetState", () => {
  const input: WaitEc2TargetInput = {
    instanceId: "i-test123",
    expectedState: "running",
  };

  it("returns success immediately when describe returns target state", async () => {
    const mockDescribe: DescribeInstanceFn = vi.fn().mockResolvedValue(
      ok({ state: "running", instanceType: "t3.micro" }),
    );

    const result = await waitForEc2TargetState(input, mockDescribe);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lastObservedState).toBe("running");
    expect(result.value.elapsedMs).toBeLessThan(1000);
  });

  it("returns success after describe returns pending then running", async () => {
    const mockDescribe: DescribeInstanceFn = vi.fn()
      .mockResolvedValueOnce(ok({ state: "pending", instanceType: "t3.micro" }))
      .mockResolvedValueOnce(ok({ state: "running", instanceType: "t3.micro" }));

    vi.useFakeTimers();
    const promise = waitForEc2TargetState(input, mockDescribe);
    await vi.advanceTimersByTimeAsync(EC2_POLL_INTERVAL_MS);
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lastObservedState).toBe("running");
  });

  it("returns timeout error when describe always returns pending", async () => {
    traceSpec("LIFE-ADAPTER-POLL", "LIFE-POLL-TIMEOUT");

    const mockDescribe: DescribeInstanceFn = vi.fn().mockResolvedValue(
      ok({ state: "pending", instanceType: "t3.micro" }),
    );

    vi.useFakeTimers();
    const promise = waitForEc2TargetState(input, mockDescribe);
    await vi.advanceTimersByTimeAsync(EC2_WAIT_TIMEOUT_MS + EC2_POLL_INTERVAL_MS);
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("TimeoutError");
  });

  it("aborts polling promptly when SIGINT is received", async () => {
    traceSpec("LIFE-ADAPTER-POLL", "LIFE-POLL-SIGNAL");

    const mockDescribe: DescribeInstanceFn = vi.fn().mockResolvedValue(
      ok({ state: "pending", instanceType: "t3.micro" }),
    );

    vi.useFakeTimers();
    const promise = waitForEc2TargetState(input, mockDescribe);
    await vi.advanceTimersByTimeAsync(1);

    process.emit("SIGINT");
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.category).toBe("TimeoutError");
    expect(result.error.message).toContain("aborted by signal");
  });

  it("propagates error when describe returns error", async () => {
    const mockDescribe: DescribeInstanceFn = vi.fn().mockResolvedValue(
      err(makeError("AwsCliError", "describe failed")),
    );

    const result = await waitForEc2TargetState(input, mockDescribe);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("AwsCliError");
    expect(result.error.message).toBe("describe failed");
  });
});

describe("waitForSsmOnline", () => {
  it("returns success immediately when getStatus returns Online", async () => {
    traceSpec("REMOTE-DOMAIN-PRECOND", "REMOTE-PRECOND-READY");

    const mockGetStatus: DescribeSsmStatusFn = vi.fn().mockResolvedValue(ok("Online"));

    const result = await waitForSsmOnline(mockGetStatus);
    expect(result.ok).toBe(true);
  });

  it("returns success after getStatus returns undefined then Online", async () => {
    traceSpec("REMOTE-DOMAIN-PRECOND", "REMOTE-PRECOND-READY");

    const mockGetStatus: DescribeSsmStatusFn = vi.fn()
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(ok("Online"));

    vi.useFakeTimers();
    const promise = waitForSsmOnline(mockGetStatus);
    await vi.advanceTimersByTimeAsync(SSM_POLL_INTERVAL_MS);
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(true);
  });

  it("returns timeout error when getStatus never returns Online", async () => {
    traceSpec("REMOTE-DOMAIN-PRECOND", "REMOTE-PRECOND-FAIL");

    const mockGetStatus: DescribeSsmStatusFn = vi.fn().mockResolvedValue(ok(undefined));

    vi.useFakeTimers();
    const promise = waitForSsmOnline(mockGetStatus);
    await vi.advanceTimersByTimeAsync(SSM_WAIT_TIMEOUT_MS + SSM_POLL_INTERVAL_MS);
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("TimeoutError");
  });
});
