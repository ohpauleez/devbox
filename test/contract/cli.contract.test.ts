import { describe, expect, it } from "vitest";

import { EXIT_CODE_BY_CATEGORY, makeError, renderErrorLines } from "../../src/domain/errors.js";
import { renderHelp, renderNoBoxesTracked, renderVersion } from "../../src/domain/output-contracts.js";

describe("top-level output contracts", () => {
  it("renders version output", () => {
    const output = renderVersion("1.2.3");
    expect(output.stdoutLines).toEqual(["devbox 1.2.3"]);
    expect(output.stderrLines).toEqual([]);
  });

  it("renders help output containing command overview and version", () => {
    const output = renderHelp("9.9.9");
    expect(output.stdoutLines[0]).toBe("devbox 9.9.9");
    expect(output.stdoutLines.join("\n")).toContain("Usage:");
    expect(output.stdoutLines.join("\n")).toContain("list");
    expect(output.stderrLines).toEqual([]);
  });

  it("renders empty list output", () => {
    const output = renderNoBoxesTracked();
    expect(output.stdoutLines).toEqual(["No boxes tracked"]);
  });
});

describe("error normalization contracts", () => {
  it("maps every category to expected exit code", () => {
    expect(EXIT_CODE_BY_CATEGORY.ValidationError).toBe(2);
    expect(EXIT_CODE_BY_CATEGORY.ConfigError).toBe(3);
    expect(EXIT_CODE_BY_CATEGORY.DependencyError).toBe(4);
    expect(EXIT_CODE_BY_CATEGORY.AwsCliError).toBe(5);
    expect(EXIT_CODE_BY_CATEGORY.NotFoundError).toBe(6);
    expect(EXIT_CODE_BY_CATEGORY.InstanceStateError).toBe(7);
    expect(EXIT_CODE_BY_CATEGORY.TimeoutError).toBe(8);
    expect(EXIT_CODE_BY_CATEGORY.ConsistencyError).toBe(9);
    expect(EXIT_CODE_BY_CATEGORY.TransportError).toBe(10);
  });

  it("renders standardized error lines", () => {
    const error = makeError("ValidationError", "invalid alias", ["detail-a", "detail-b"]);
    const lines = renderErrorLines(error);
    expect(lines[0]).toBe("[devbox] ValidationError: invalid alias");
    expect(lines[1]).toBe("  detail-a");
    expect(lines[2]).toBe("  detail-b");
  });
});
