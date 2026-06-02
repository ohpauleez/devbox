import { describe, expect, it, vi } from "vitest";
import { normalizeError, printError } from "../src/domain/errors.js";
import { printListTable, printNoBoxes } from "../src/domain/output-contracts.js";

describe("error model contracts", () => {
  it("normalizes unknown errors to ValidationError", () => {
    const err = normalizeError(new Error("x"));
    expect(err.code).toBe("ValidationError");
  });

  it("prints summary line and optional details", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = normalizeError(new Error("x"));
    printError(err);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("output contracts", () => {
  it("prints no boxes line", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printNoBoxes();
    expect(spy).toHaveBeenCalledWith("No boxes tracked\n");
    spy.mockRestore();
  });

  it("prints list table with current marker", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printListTable([
      {
        current: true,
        alias: "work",
        instanceId: "i-1",
        state: "running",
        instanceType: "t3",
      },
    ]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
