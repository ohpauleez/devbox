# Spec Traceability Plan

## Product Design

`spec-traceability` connects canonical OpenSpec identifiers to TypeScript source code and Vitest tests.

The feature gives specs and tests a shared, machine-checkable reference point. Canonical identifiers live in OpenSpec markdown and traced tests declare, in visible test source, which identifier or identifiers they verify by calling `traceSpec(...)`.
The same spec identifiers can be used within TSDoc to identify how TypeScript code satisfies the specification.

The tool has two distinct jobs:

- validate traced references during ordinary test execution
- enforce spec coverage in a dedicated coverage run

This separation keeps local Vitest runs lightweight while still allowing CI or a dedicated package script to enforce full traceability coverage.

The implementation is specific to TypeScript and Vitest.

## Rationale

This design keeps the spec authoritative and makes the traceability relationship visible to authors reading either the spec or the tests.

`traceSpec(...)` is the TypeScript/Vitest utility to use within test source:

- it is explicit and visible in test source
- it fails the declaring test directly for malformed or unknown identifiers
- it works naturally in ordinary tests, async tests, and `it.each(...)`
- it avoids brittle Vitest monkey-patching or wrapper-heavy APIs

The catalog and validation rules improve correctness:

- identifiers are canonical only when discovered from OpenSpec `spec.md` files
- cross-file duplicate identifiers fail catalog building before trace validation proceeds
- unknown identifiers fail only the declaring test
- tests without traceability declarations are unaffected
- coverage enforcement is controlled independently from reference validation

The repository-specific discovery scope is:

- include all `spec.md` files under `openspec/specs/**`
- include all active change specs under `openspec/changes/**`
- exclude archived changes under `openspec/changes/archive/**`

This keeps active requirements and active change work in scope while ignoring archived historical specs.

## Goals

- Make canonical spec identifiers visible and machine-checked.
- Make traced tests explicitly declare what they verify.
- Fail fast on malformed, unknown, or duplicate identifiers.
- Report useful provenance for diagnostics.
- Allow local development runs to validate references without requiring full-suite coverage.
- Enforce that every canonical identifier is covered by at least one traced test in a dedicated coverage run.

## Non-Goals

- Enforcing a bijection between identifiers and tests.
- Requiring every test to participate in traceability.
- Inferring traceability automatically from test names or file names.
- Annotating implementation code as part of the first version.
- Parsing archived specs into the canonical catalog.

## Canonical Spec Files

Canonical identifiers are discovered only from included OpenSpec files matching:

- `openspec/specs/**/spec.md`
- `openspec/changes/**/spec.md`

The following paths are excluded from canonical discovery:

- `openspec/changes/archive/**`

Files outside these included locations do not contribute identifiers to the canonical catalog, even if they contain identifier-looking text.

## Identifier Rules

### Syntax

A canonical spec identifier SHALL:

- appear in markdown inside square brackets, for example `[BOX-NULL-REJECT]`
- be extracted without brackets, for example `BOX-NULL-REJECT`
- match the pattern `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`

Bare uppercase kebab tokens without brackets are ignored.

Bracketed tokens that do not match the identifier pattern are ignored.

Bracketed tokens inside inline code spans or fenced code blocks are ignored.

### Placement

Identifiers should be placed on `Requirement` or `Scenario` headers.

The parser should still recognize valid bracketed identifiers elsewhere in markdown so long as they are outside inline code and fenced code blocks.

### Style Guidance

Identifiers should be semantic rather than implementation-specific.

Prefer identifiers that are:

- behavior-oriented
- stable if implementation details change
- small enough to map naturally to one or a few traced tests

Avoid identifiers that:

- encode implementation choices
- bundle many unrelated behaviors together
- describe internal refactorings instead of externally visible guarantees

Examples:

- good: `BOX-NULL-REJECT`
- worse: `BOX-USE-OBJECTS-REQUIRE-NON-NULL`

## Catalog Semantics

For each discovered identifier, the catalog stores:

- identifier
- defining file
- defining line number
- nearest `Requirement` or `Scenario` heading when available

If an identifier is placed directly on a `Requirement` or `Scenario` heading, that heading should be retained as the provenance context without the bracketed identifier token in the stored heading text.

If the same identifier is defined in more than one included spec file, catalog construction SHALL fail before trace validation proceeds.

If the same identifier appears multiple times within one spec file, that repetition is permitted. The first occurrence is retained for provenance.

## Traced Test API

Traced Vitest tests declare their identifiers explicitly by calling `traceSpec(...)` inside the test body.

Example:

```ts
import { describe, expect, it } from "vitest";
import { traceSpec } from "../test/support/spec-trace.js";

describe("parseAlias", () => {
  it("rejects empty string", () => {
    traceSpec("BOX-ALIAS-FAIL");
    const result = parseAlias("");
    expect(result.ok).toBe(false);
  });

  it("uses one test for multiple related identifiers", () => {
    traceSpec("BOX-INIT-SUCCESS", "BOX-CURRENT-VALID");
    // assertions
  });
});
```

This API is explicit, ergonomic, and idiomatic for TypeScript while still satisfying the visibility requirement: authors can see the identifier declaration directly in test source.

## Traced Test Rules

`traceSpec(...)` is the TypeScript/Vitest analogue of an explicit spec-trace declaration.

Rules:

- `traceSpec()` with no identifiers is an error
- each declared identifier must use the bare identifier without brackets
- each declared identifier must match `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`
- malformed identifiers fail with a format error distinct from an unknown-identifier error
- identifiers not present in the canonical catalog fail as unknown references
- unknown or malformed identifiers fail only the declaring test
- tests without `traceSpec(...)` are unaffected

If the same identifier is declared more than once within one test, the harness should record it once for coverage accounting.

## Validation Behavior

Reference validation always runs for traced tests.

During a test run:

- the catalog is built from the full included set of canonical spec files
- each `traceSpec(...)` call validates arguments immediately
- a malformed identifier fails the current test with a format diagnostic
- an unknown identifier fails the current test with an unknown-reference diagnostic
- untraced tests continue normally with no traceability checks

This behavior also applies during subset runs. Running one test file or one filtered test still validates traced identifiers against the full canonical catalog.

## Coverage Behavior

Coverage enforcement is independent from reference validation.

Reference validation is always active for traced tests.

Coverage enforcement runs only when a dedicated package script enables it, for example:

- `npm test` or equivalent: validation only
- `npm run test:trace`: validation plus coverage enforcement

When coverage is enabled:

- every canonical identifier must be declared by at least one traced test in the run
- uncovered identifiers fail the run
- an empty catalog trivially passes coverage

Multiple tests may reference the same identifier without causing a coverage failure.

## Diagnostics

Diagnostics should be provenance-aware whenever provenance exists.

### Duplicate canonical identifier

Report:

- identifier
- both defining files
- both defining line numbers
- nearest heading context when available

This failure occurs during catalog construction, before trace validation proceeds.

### Malformed traced identifier

Report:

- test file
- test title
- offending identifier
- expected pattern

### Unknown traced identifier

Report:

- test file
- test title
- offending identifier

Unknown identifiers have no canonical provenance because they do not exist in the catalog.

### Uncovered canonical identifier

Report:

- identifier
- defining file
- defining line number
- nearest heading context when available

## Empty Catalog Behavior

If no included canonical spec files exist, or the included files contain no valid identifiers, the catalog is empty.

In that case:

- traced tests still fail on unknown identifiers, because no declared identifier can be found in the empty catalog
- coverage enforcement passes trivially, because there are no canonical identifiers to cover

## Review-Only Requirements

Some requirements are better verified by reasoning, design review, or cited documentation than by executable assertions.

Those requirements should remain traceable through a passing traced test with a short explanatory comment and the `name` argument if `it` should start with "REVIEW:":

Example:

```ts
it("REVIEW: documents why this requirement is review-only", () => {
  traceSpec("DIST-PARITY-FAIL");
  // Verified by release review against the documented packaging process.
  expect(true).toBe(true);
});
```

## Recommended Workflow

For new work:

- add canonical identifiers to important `Requirement` and `Scenario` headers before implementation begins
- use identifiers to keep the spec authoritative and give specs, tests, and review a shared reference point
- add traced tests as behavior is implemented
- run the dedicated trace coverage script before merging

For existing or legacy specs:

- adding identifiers during review is a reasonable retrofit step
- backfill traced tests incrementally

A final review pass should still confirm:

- identifier granularity is appropriate
- traced tests match the intended requirements
- review-only requirements are explicitly documented where executable assertions are not the right mechanism

## Implementation Design

### 1. Catalog parser

Implement a small parser that:

- scans included `spec.md` files under `openspec/`
- excludes `openspec/changes/archive/**`
- tokenizes markdown conservatively enough to ignore inline code spans and fenced code blocks
- extracts valid bracketed identifiers
- tracks line numbers and nearest `Requirement` or `Scenario` headings
- rejects cross-file duplicates

The parser should be deterministic, small, and easy to unit test.

### 2. Runtime trace API

Implement `traceSpec(...ids: string[])` in a small Vitest support module.

The function should:

- require at least one identifier
- validate identifier format
- validate existence against the full catalog
- associate identifiers with the currently running Vitest test
- de-duplicate repeated identifiers within the same test for accounting

The function should throw normal test failures so malformed and unknown identifiers are attached to the declaring test.

### 3. Vitest setup integration

Add traceability initialization through Vitest setup so the catalog is available during test execution.

The setup should:

- load or construct the canonical catalog for the run
- expose the runtime state needed by `traceSpec(...)`
- work during full runs and subset runs

The public API should remain an explicit import rather than a hidden global by default.

### 4. Coverage aggregation

Add end-of-run aggregation for traced declarations.

When coverage mode is enabled, compare the set of canonical identifiers to the set of traced identifiers seen during the run and fail if any canonical identifiers are uncovered.

Implementation may use a custom reporter, run-scoped artifacts, or another Vitest-compatible mechanism, but the external behavior should remain the same.

### 5. Package scripts

Add a dedicated script in `package.json` for coverage enforcement.

Recommended shape:

- `test`: ordinary `vitest run`
- `test:trace`: enables trace coverage mode and runs `vitest run`

The exact environment variable name is implementation-specific, for example `SPEC_TRACE_COVERAGE=true`.

## Rollout Plan

### Phase 1: Parser and diagnostics

- implement catalog discovery
- implement identifier extraction rules for the simple purpose-built parser
- implement duplicate detection
- add unit tests for parser behavior and diagnostics

### Phase 2: Traced test validation

- implement `traceSpec(...)`
- connect it to Vitest runtime state
- fail traced tests for empty declarations, malformed identifiers, and unknown identifiers
- add tests for plain, async, and parameterized Vitest usage

### Phase 3: Coverage mode

- implement end-of-run aggregation
- add dedicated coverage script in `package.json`
- report uncovered identifiers with provenance
- verify empty-catalog behavior

### Phase 4: Documentation

- document canonical discovery scope
- document identifier rules and style guidance
- document `traceSpec(...)` usage
- document the dedicated coverage script
- document the review-only requirement pattern

### Phase 5: Adoption

- backfill traced tests spec by spec
- start with active specs and active changes
- enable the dedicated coverage script in CI once enough traced coverage exists

## Acceptance Criteria

- Valid bracketed identifiers are discovered from included non-archived `spec.md` files.
- Bracketed identifier-like text in inline code and fenced code blocks is ignored.
- Duplicate identifiers across included spec files fail catalog construction with provenance.
- `traceSpec()` with no arguments fails the declaring test.
- Malformed identifiers in `traceSpec(...)` fail the declaring test with a format error.
- Unknown identifiers in `traceSpec(...)` fail the declaring test with an unknown-reference error.
- Tests without `traceSpec(...)` run normally and are ignored by the harness.
- Subset runs validate traced identifiers against the full canonical catalog.
- Coverage enforcement runs only in the dedicated coverage script.
- Coverage mode fails when any canonical identifier is not declared by at least one traced test.
- Coverage mode passes trivially for an empty canonical catalog.

## Open Questions To Resolve During Implementation

- whether the catalog should be cached per worker or once per run through a shared artifact
- whether diagnostics should suggest similar known identifiers for unknown-reference failures
- whether the public support module should live under `test/support/` or `src/testing/`

### Resolved questions

- This utility is going to use a small purpose-built scanner

The preferred implementation bias is the smallest correct design: a small parser, an explicit `traceSpec(...)` helper, and a dedicated coverage script layered onto existing Vitest configuration.
