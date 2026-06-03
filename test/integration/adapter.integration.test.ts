import { describe, expect, it } from "vitest";

import { parseRemotePath } from "../../src/domain/remote-path.js";
import { decideDownAction, decideUpAction } from "../../src/domain/instance-state.js";

describe("state-machine integration-oriented checks", () => {
  it("enforces up/down legal transition decisions", () => {
    const upFromStopped = decideUpAction("stopped");
    expect(upFromStopped.ok && upFromStopped.value.submitStart).toBe(true);

    const downFromRunning = decideDownAction("running");
    expect(downFromRunning.ok && downFromRunning.value.submitStop).toBe(true);

    const upFromTerminated = decideUpAction("terminated");
    expect(upFromTerminated.ok).toBe(false);
  });

  it("rejects unsafe remote paths before transport", () => {
    expect(parseRemotePath("/tmp/ok.txt").ok).toBe(true);
    expect(parseRemotePath("\u0000bad").ok).toBe(false);
  });
});
