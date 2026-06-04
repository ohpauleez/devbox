import { describe, expect, it } from "vitest";
import {
  makeError,
  renderErrorLines,
  exitCodeForError,
  EXIT_CODE_BY_CATEGORY,
  type ErrorCategory,
} from "../../src/domain/errors.js";

describe("EXIT_CODE_BY_CATEGORY", () => {
  const expected: Record<ErrorCategory, number> = {
    ValidationError: 2,
    ConfigError: 3,
    DependencyError: 4,
    AwsCliError: 5,
    NotFoundError: 6,
    InstanceStateError: 7,
    TimeoutError: 8,
    ConsistencyError: 9,
    TransportError: 10,
  };

  it.each(Object.entries(expected))("%s maps to exit code %d", (category, code) => {
    expect(EXIT_CODE_BY_CATEGORY[category as ErrorCategory]).toBe(code);
  });

  it("covers all 9 categories", () => {
    expect(Object.keys(EXIT_CODE_BY_CATEGORY)).toHaveLength(9);
  });
});

describe("renderErrorLines", () => {
  it("produces first line format [devbox] Category: message", () => {
    const error = makeError("ConfigError", "something broke");
    const lines = renderErrorLines(error);
    expect(lines[0]).toBe("[devbox] ConfigError: something broke");
  });

  it("details are indented with 2 spaces", () => {
    const error = makeError("ValidationError", "bad input", ["detail one", "detail two"]);
    const lines = renderErrorLines(error);
    expect(lines[1]).toBe("  detail one");
    expect(lines[2]).toBe("  detail two");
  });
});

describe("makeError", () => {
  it("with no details omits details field", () => {
    const error = makeError("ConfigError", "msg");
    expect("details" in error).toBe(false);
  });

  it("with details includes them", () => {
    const error = makeError("ConfigError", "msg", ["d1"]);
    expect(error.details).toEqual(["d1"]);
  });
});

describe("exitCodeForError", () => {
  it.each([
    ["ValidationError", 2],
    ["ConfigError", 3],
    ["TransportError", 10],
  ] as const)("returns correct code for %s", (category, code) => {
    const error = makeError(category, "test");
    expect(exitCodeForError(error)).toBe(code);
  });
});
