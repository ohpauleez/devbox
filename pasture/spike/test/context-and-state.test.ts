import { describe, expect, it } from "vitest";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";
import { requireAlias, requireCurrent } from "../src/domain/context.js";
import { assertDownPreState, assertUpPreState } from "../src/domain/instance-state.js";

describe("context contracts", () => {
  it("requireCurrent fails when current is absent", () => {
    const cfg = synthesizeFirstRunConfig();
    expect(() => requireCurrent(cfg)).toThrow("No current alias is set");
  });

  it("requireCurrent fails when current points to missing alias", () => {
    const cfg = synthesizeFirstRunConfig();
    cfg.current = "missing";
    expect(() => requireCurrent(cfg)).toThrow("missing alias");
  });

  it("requireCurrent returns alias and instance", () => {
    const cfg = synthesizeFirstRunConfig();
    cfg.current = "work";
    cfg.boxes.work = { instanceId: "i-1" };
    expect(requireCurrent(cfg)).toEqual({ alias: "work", instanceId: "i-1" });
  });

  it("requireAlias fails when alias missing", () => {
    const cfg = synthesizeFirstRunConfig();
    expect(() => requireAlias(cfg, "missing")).toThrow("Alias not found");
  });

  it("requireAlias returns instance for existing alias", () => {
    const cfg = synthesizeFirstRunConfig();
    cfg.boxes.work = { instanceId: "i-1" };
    expect(requireAlias(cfg, "work")).toEqual({ instanceId: "i-1" });
  });
});

describe("instance-state contracts", () => {
  it("up rejects shutting-down and terminated", () => {
    expect(() => assertUpPreState("shutting-down", "i-1")).toThrow("Cannot start");
    expect(() => assertUpPreState("terminated", "i-1")).toThrow("Cannot start");
  });

  it("up allows running/pending/stopped/stopping", () => {
    expect(() => assertUpPreState("running", "i-1")).not.toThrow();
    expect(() => assertUpPreState("pending", "i-1")).not.toThrow();
    expect(() => assertUpPreState("stopped", "i-1")).not.toThrow();
    expect(() => assertUpPreState("stopping", "i-1")).not.toThrow();
  });

  it("down rejects shutting-down and terminated", () => {
    expect(() => assertDownPreState("shutting-down", "i-1")).toThrow("Cannot stop");
    expect(() => assertDownPreState("terminated", "i-1")).toThrow("Cannot stop");
  });

  it("down allows running/stopping/stopped/pending", () => {
    expect(() => assertDownPreState("running", "i-1")).not.toThrow();
    expect(() => assertDownPreState("stopping", "i-1")).not.toThrow();
    expect(() => assertDownPreState("stopped", "i-1")).not.toThrow();
    expect(() => assertDownPreState("pending", "i-1")).not.toThrow();
  });
});
