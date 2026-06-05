import { describe, expect, it } from "vitest";
import {
  renderVersion,
  renderHelp,
  renderNoBoxesTracked,
  renderListTable,
} from "../../src/domain/output-contracts.js";
import { traceSpec } from "../support/spec-trace.js";

describe("renderVersion", () => {
  it("format is 'devbox X.Y.Z'", () => {
    traceSpec("BOX-VERSION-FLAG", "DIST-VERSION-PARITY");

    const output = renderVersion("1.2.3");
    expect(output.stdoutLines[0]).toBe("devbox 1.2.3");
    expect(output.stdoutLines).toHaveLength(1);
  });
});

describe("renderHelp", () => {
  const output = renderHelp("1.0.0");

  it("includes version", () => {
    traceSpec("BOX-HELP-FLAG", "DIST-HELP-PARITY");

    expect(output.stdoutLines[0]).toContain("devbox 1.0.0");
  });

  it("includes usage section", () => {
    traceSpec("BOX-HELP-FLAG", "DIST-HELP-PARITY");

    expect(output.stdoutLines.some((l) => l.includes("Usage:"))).toBe(true);
  });

  it("lists all commands", () => {
    traceSpec("BOX-HELP-FLAG", "DIST-HELP-PARITY");

    const text = output.stdoutLines.join("\n");
    for (const cmd of ["list", "init", "add", "rm", "switch", "up", "down", "connect", "cp"]) {
      expect(text).toContain(cmd);
    }
  });
});

describe("renderNoBoxesTracked", () => {
  it("outputs 'No boxes tracked'", () => {
    traceSpec("BOX-LIST-EMPTY");

    const output = renderNoBoxesTracked();
    expect(output.stdoutLines[0]).toBe("No boxes tracked");
  });
});

describe("renderListTable", () => {
  const rows = [
    { isCurrent: true, alias: "mybox", instanceId: "i-abc123", instanceType: "t3.micro", state: "running" },
    { isCurrent: false, alias: "other", instanceId: "i-def456", instanceType: "t3.large", state: "stopped" },
  ];
  const output = renderListTable(rows);

  it("header row has right columns", () => {
    traceSpec("BOX-LIST-TABLE");

    const header = output.stdoutLines[0];
    expect(header).toContain("alias");
    expect(header).toContain("instance-id");
    expect(header).toContain("instance-type");
    expect(header).toContain("state");
  });

  it("current indicator is *", () => {
    traceSpec("BOX-LIST-TABLE");

    expect(output.stdoutLines[1].startsWith("*")).toBe(true);
    expect(output.stdoutLines[2].startsWith(" ")).toBe(true);
  });

  it("column alignment works (consistent column positions)", () => {
    traceSpec("BOX-LIST-TABLE");

    const headerAliasIdx = output.stdoutLines[0].indexOf("alias");
    const row1AliasIdx = output.stdoutLines[1].indexOf("mybox");
    expect(headerAliasIdx).toBe(row1AliasIdx);
  });
});
