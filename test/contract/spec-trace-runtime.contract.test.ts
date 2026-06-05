import { afterEach, describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { createCanonicalCatalog } from "../support/spec-trace/catalog.js";
import {
  computeUncoveredCatalogEntries,
  createTraceRuntimeState,
  finalizeTraceCoverage,
  recordTraceDeclaration,
  resetTraceRuntimeState,
  setTraceRuntimeState,
} from "../support/spec-trace/runtime.js";

/**
 * Install a deterministic catalog for one runtime test.
 *
 * @param identifiers - identifiers to include in the temporary catalog
 * @param coverageEnabled - whether to enable end-of-run coverage enforcement
 */
function installTraceState(
  identifiers: readonly string[],
  coverageEnabled: boolean = false,
): ReturnType<typeof createTraceRuntimeState> {
  const catalog = createCanonicalCatalog(
    identifiers.map((identifier, index) => ({
      identifier,
      file: `/repo/openspec/specs/${identifier.toLowerCase()}/spec.md`,
      line: index + 1,
      heading: `Requirement: ${identifier}`,
    })),
  );
  const state = createTraceRuntimeState({ catalog, coverageEnabled });
  setTraceRuntimeState(state);
  return state;
}

afterEach(() => {
  resetTraceRuntimeState();
});

describe("traceSpec runtime validation", () => {
  it("accepts ordinary traced tests", () => {
    const state = installTraceState(["TRACE-RUNTIME-OK"]);

    traceSpec("TRACE-RUNTIME-OK");

    expect(state.seenIdentifiers).toEqual(new Set(["TRACE-RUNTIME-OK"]));
  });

  it("accepts async traced tests", async () => {
    const state = installTraceState(["TRACE-RUNTIME-ASYNC"]);

    await Promise.resolve();
    traceSpec("TRACE-RUNTIME-ASYNC");

    expect(state.seenIdentifiers).toEqual(new Set(["TRACE-RUNTIME-ASYNC"]));
  });

  it.each(["TRACE-RUNTIME-EACH-A", "TRACE-RUNTIME-EACH-B"])(
    "accepts parameterized traced tests for %s",
    (identifier) => {
      const state = installTraceState(["TRACE-RUNTIME-EACH-A", "TRACE-RUNTIME-EACH-B"]);

      traceSpec(identifier);

      expect(state.seenIdentifiers.has(identifier)).toBe(true);
    },
  );

  it("fails on empty trace declarations", () => {
    installTraceState(["TRACE-RUNTIME-EMPTY"]);

    expect(() => traceSpec()).toThrowError(/at least one canonical identifier/u);
  });

  it("fails on malformed identifiers with a format-specific diagnostic", () => {
    installTraceState(["TRACE-RUNTIME-MALFORMED"]);

    expect(() => traceSpec("trace-runtime-malformed")).toThrowError(/malformed identifier/u);
  });

  it("fails on unknown identifiers with a catalog-specific diagnostic", () => {
    installTraceState(["TRACE-RUNTIME-KNOWN"]);

    expect(() => traceSpec("TRACE-RUNTIME-UNKNOWN")).toThrowError(/unknown identifier/u);
  });

  it("de-duplicates repeated identifiers within one test for accounting", () => {
    const state = installTraceState(["TRACE-RUNTIME-DEDUPE"]);

    traceSpec("TRACE-RUNTIME-DEDUPE", "TRACE-RUNTIME-DEDUPE");

    expect(state.seenIdentifiers).toEqual(new Set(["TRACE-RUNTIME-DEDUPE"]));
    expect([...state.identifiersByTest.values()]).toEqual([new Set(["TRACE-RUNTIME-DEDUPE"])]);
  });
});

describe("spec trace coverage reporting", () => {
  it("reports uncovered identifiers with provenance when coverage mode is enabled", () => {
    const state = installTraceState(["TRACE-COVERAGE-A", "TRACE-COVERAGE-B"], true);

    recordTraceDeclaration(state, "test-a", ["TRACE-COVERAGE-A"]);

    expect(computeUncoveredCatalogEntries(state).map((entry) => entry.identifier)).toEqual([
      "TRACE-COVERAGE-B",
    ]);
    expect(finalizeTraceCoverage(state, "/repo")).toContain("TRACE-COVERAGE-B");
  });

  it("passes coverage mode trivially for an empty catalog", () => {
    const state = installTraceState([], true);

    expect(computeUncoveredCatalogEntries(state)).toEqual([]);
    expect(finalizeTraceCoverage(state, "/repo")).toBeUndefined();
  });

  it("ignores untraced tests for coverage accounting", () => {
    const state = installTraceState(["TRACE-UNTRACED-A"], true);

    expect(state.seenIdentifiers).toEqual(new Set());
    expect(finalizeTraceCoverage(state, "/repo")).toContain("TRACE-UNTRACED-A");
  });
});
