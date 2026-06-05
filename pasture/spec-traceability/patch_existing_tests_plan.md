# Spec Traceability Remediation Plan

This plan turns the current traceability assessment into concrete implementation work.

The objective is not only to increase the number of traced identifiers, but to make the traceability evidence honest:

- traced tests should map to behavior they actually assert
- requirement and scenario identifiers should be represented at the right granularity
- high-risk command and adapter behavior should gain executable coverage before lower-value metadata checks
- `npm run test:trace` should eventually become a trustworthy CI gate, not a noisy or misleading one

## Goals

1. Tighten traceability on tests that already exercise real behavior.
2. Remove weak or misleading trace mappings.
3. Add new tests for high-risk uncovered command and adapter behavior.
4. Backfill lower-risk distribution and registry edge cases.
5. Re-run the traceability audit and only then consider enabling `test:trace` in CI.

## Guiding Principles

Apply the rules from `docs/spec_traceability.md` while doing this work:

- Prefer scenario identifiers over requirement identifiers unless a test truly covers the whole requirement.
- Keep `traceSpec(...)` close to the exact assertion or property that exercises the behavior.
- Do not use traceability to over-claim coverage.
- Do not satisfy executable requirements with review-only tests unless executable verification is genuinely the wrong mechanism.
- When a current test covers a narrower behavior than the traced identifier suggests, narrow the identifier rather than keeping a misleading mapping.
- Keep new tests small and behavior-oriented.

## Current State Summary

The repository currently has three categories of spec coverage:

1. **Explicit and reasonably aligned traced coverage**
2. **Existing tests that likely exercise the behavior but are not traced yet**
3. **Specs with no apparent test coverage**

The strongest existing coverage is in:

- lifecycle state-machine domain behavior
- remote path parsing
- SSH-user resolution
- some registry config and validation behavior

The weakest areas are:

- remote `connect` and `cp` command flows
- lifecycle command-path behavior
- registry command-path consistency and AWS-facing flows
- distribution artifact and parity verification

## Phase 1: Fix Existing Representation

### Objective

Make existing tests honestly represent the specs they already exercise.

This is the highest-leverage first step because it improves traceability without requiring large amounts of new code.

### Work Items

#### 1. Add `traceSpec(...)` to existing tests with clear behavioral coverage

Update the following files first:

- `test/contract/alias.contract.test.ts`
  - Add traces for:
    - `BOX-ALIAS-ACCEPT`
    - `BOX-ALIAS-FAIL`

- `test/contract/config-schema.contract.test.ts`
  - Add traces for:
    - `BOX-CURRENT-VALID`
    - `BOX-CURRENT-FAIL`
    - `BOX-CONFIG-FIRSTRUN`
    - `BOX-CONFIG-FAIL`

- `test/integration/command-flows.integration.test.ts`
  - Add traces for:
    - `BOX-SWITCH-SUCCESS`
    - `BOX-RM-LOCAL`
    - `BOX-RM-CURRENT-CLEAR`

- `test/integration/config-store.integration.test.ts`
  - Add traces for:
    - `BOX-ATOMIC-SUCCESS`
    - `BOX-ATOMIC-FAIL`
    - `BOX-STALELOCK-PID`

- `test/contract/init-mapper.contract.test.ts`
  - Add traces for:
    - `BOX-INIT-UNKNOWN-FIELD`
    - `BOX-INIT-REJECT-IR`
    - `BOX-INIT-NI-CONFLICT`
    - `BOX-CONFIG-MISSING-IMAGEID`
    - `BOX-CONFIG-MISSING-IAM`
    - `BOX-INIT-USERDATA-FILE`

- `test/contract/tags.contract.test.ts`
  - Add traces for:
    - `BOX-TAGS-VALUE-FAIL`
    - `BOX-TAGS-NAME-OVERRIDE`

- `test/contract/instance-state.contract.test.ts`
  - Add traces for:
    - `LIFE-UP-START`
    - `LIFE-DOWN-STOP`
    - idempotent and pending/stopping scenarios where the assertions are already explicit:
      - `LIFE-UP-PENDING`
      - `LIFE-UP-IDEMPOTENT`
      - `LIFE-DOWN-STOPPING`
      - `LIFE-DOWN-IDEMPOTENT`

- `test/integration/ec2-wait.integration.test.ts`
  - Add traces for:
    - `LIFE-POLL-TIMEOUT`
    - `REMOTE-PRECOND-READY`
    - `REMOTE-PRECOND-FAIL`
  - Only do this where the assertions really match the spec behavior.

- `test/contract/remote-access.contract.test.ts`
  - Add traces for:
    - `REMOTE-DOMAIN-SSHUSER`
    - `REMOTE-CLI-FAIL`
    - `REMOTE-DOMAIN-PATH`

#### 2. Prefer scenario IDs when possible

During Phase 1, favor tracing the narrowest specific scenario that the test actually proves.

Example:

- If a test only proves `current pointing to missing alias rejects`, prefer `BOX-CURRENT-FAIL`.
- Do not trace the umbrella requirement `BOX-DOMAIN-STATE` unless a test actually demonstrates the whole requirement surface.

### Acceptance Criteria For Phase 1

- Existing tests with clear behavioral coverage have explicit `traceSpec(...)` declarations.
- Traced identifiers match the actual assertions made by the test.
- No new review-only traces are introduced in place of executable behavior.

## Phase 2: Remove Weak Trace Claims

### Objective

Correct trace mappings that currently overstate what the tests prove.

### Problem Areas

#### 1. Distribution traces in `test/integration/build.integration.test.ts`

Current traces are too weak for the specs they claim:

- `DIST-CLI-BUNDLE` is currently associated with a Node engine check, which does not verify the existence or behavior of `dist/devbox.js`.
- `DIST-NPM-SUCCESS` is currently represented by metadata checks only, not an actual installability or runnable-distribution check.

### Required Actions

- Remove weak trace IDs from tests that do not actually prove the behavior.
- Reassign those identifiers only after stronger tests exist.
- Keep pure metadata tests untraced if they are not sufficient for the relevant spec.

#### 2. Renderer-level traces for CLI-level specs

Current tests in `test/contract/output-contracts.contract.test.ts` trace:

- `BOX-VERSION-FLAG`
- `BOX-HELP-FLAG`
- `DIST-VERSION-PARITY`
- `DIST-HELP-PARITY`

Those tests only exercise render helpers, not top-level CLI dispatch behavior or cross-distribution parity.

### Required Actions

- Decide whether the spec is satisfied by render contracts alone.
- If not, remove or narrow the trace now and replace it later with command-path tests.

#### 3. Resolver-level traces for command-path remote specs

Current `REMOTE-CLI-SSHUSER` trace coverage comes from SSH-user resolution tests.
That proves precedence rules, but not necessarily that `connect` and `cp` commands pass the override through the full path.

### Required Actions

- Keep the lower-level trace only if the scenario is intentionally specified at resolver level.
- Otherwise move that trace to command-path tests that verify argument flow from CLI to remote behavior.

### Acceptance Criteria For Phase 2

- No trace ID remains attached to a test that proves only an adjacent or weaker claim.
- Distribution and CLI traces reflect actual behavior, not just metadata or rendering helpers.

## Phase 3: Add High-Risk Missing Tests

### Objective

Cover the missing command and adapter behaviors that matter most to correctness and user-visible behavior.

This is the most important phase for increasing justified confidence.

### Priority A: Remote Access

These are currently the largest gaps:

- `REMOTE-DOMAIN-CONNECT`
- `REMOTE-CONNECT-SUCCESS`
- `REMOTE-CONNECT-CONSISTENCY`
- `REMOTE-DOMAIN-CP`
- `REMOTE-CP-SUCCESS`
- `REMOTE-CP-CONSISTENCY`
- `REMOTE-DOMAIN-SESSION`
- `REMOTE-SESSION-EXIT`
- `REMOTE-ADAPTER-STAGE`
- `REMOTE-STAGE-SUCCESS`
- `REMOTE-STAGE-FAIL`
- `REMOTE-ADAPTER-CLEANUP`
- `REMOTE-CLEANUP-SUCCESS`
- `REMOTE-CLEANUP-FAIL`
- `REMOTE-ADAPTER-KEYSTORE`
- `REMOTE-KEY-AGENT`
- `REMOTE-KEY-TEMP`
- `REMOTE-KEY-REMOTE-CLEANUP`
- `REMOTE-DOMAIN-FILESIZE`
- `REMOTE-CP-LARGESIZE`

### Recommended test additions

Create or extend:

- `test/integration/remote-access.integration.test.ts`

Test themes:

- `connect` success updates `lastConnectAt` only after local commit succeeds
- `connect` reports `ConsistencyError` if remote success occurs but local commit fails
- `cp` uploads to temp path and finalizes atomically
- `cp` reports `ConsistencyError` if finalization succeeds but local commit fails
- SSH exit code is propagated
- staging failure stops transport
- cleanup is attempted and failure is reported properly
- agent-key vs temporary-key behavior is handled correctly
- large file acceptance has no artificial size-limit rejection

### Priority B: Lifecycle Commands

Missing lifecycle coverage:

- `LIFE-CURRENT-REQ`
- `LIFE-CLI-SUCCESS`
- `LIFE-DOMAIN-STALE`
- `LIFE-STALE-FAIL`
- `LIFE-STALE-PASS`
- `LIFE-POLL-SIGNAL`
- `LIFE-DOMAIN-SCOPE`
- `LIFE-SCOPE-ACTIVE`
- `LIFE-SCOPE-FAIL`

### Recommended test additions

Create or extend:

- `test/integration/lifecycle-commands.integration.test.ts`

Test themes:

- `up` and `down` require current box selection
- successful lifecycle commands print the instance ID
- stale/missing instance returns `NotFoundError`
- active account/region is authoritative
- signal during polling aborts cleanly and does not report false success

### Priority C: Registry Command Flows

Missing or weak registry behavior:

- `BOX-INSTANCEID-WARN`
- `BOX-INSTANCEID-FAIL`
- `BOX-INIT-SUCCESS`
- `BOX-INIT-CONSISTENCY`
- `BOX-ADD-SUCCESS`
- `BOX-ADD-FAIL`
- `BOX-RM-CONSISTENCY`
- `BOX-SWITCH-FAIL`

### Recommended test additions

Create or extend:

- `test/integration/registry-commands.integration.test.ts`

Test themes:

- `add` succeeds when instance is describable and updates `current`
- `add` fails when instance is undescribable
- malformed-looking instance IDs warn but do not fail if AWS accepts them
- `init` success commits tracking and sets `current`
- `init` consistency failures report divergence when AWS succeeds but local commit fails
- `switch` missing alias fails without mutation
- `rm --terminate` consistency behavior is explicit

### Acceptance Criteria For Phase 3

- High-risk command and adapter behaviors have executable tests.
- New tests use `traceSpec(...)` with scenario IDs that match the asserted behavior.
- Existing weak traces can be replaced with stronger evidence.

## Phase 4: Add Medium- and Lower-Risk Gaps

### Objective

Backfill the remaining uncovered but lower-priority specs after the main command-path gaps are covered.

### Box-Registry Follow-Up

Remaining likely gaps:

- `BOX-REGISTRY-CLI-FAIL`
- `BOX-NOARGS-LIST`
- `BOX-PERMS-CONFIG`
- `BOX-STALELOCK-AGE`
- `BOX-INIT-SG-ALLOWED`
- `BOX-TAGS-NONINSTANCE`
- `BOX-LIST-BATCH-SINGLE`
- `BOX-LIST-BATCH-UNAVAIL`
- `BOX-RM-WARN-MSG`

### Recommended test additions

- Extend command and config-store integration suites.
- Add focused tests instead of one broad integration scenario.

### Distribution Follow-Up

Remaining gaps:

- `DIST-NPM-FAIL`
- `DIST-BUNDLE-SHEBANG`
- `DIST-BUNDLE-FAIL`
- `DIST-DOMAIN-PARITY`
- `DIST-PARITY-SMOKE`
- `DIST-PARITY-FAIL`

### Recommended test additions

Create or extend:

- `test/integration/distribution.integration.test.ts`

Test themes:

- bundled artifact exists at `dist/devbox.js`
- first line is `#!/usr/bin/env node`
- bundle can run without depending on TS source tree at runtime
- supported commands behave the same through the compiled CLI and bundled artifact
- parity failures are detectable through output and exit-code comparison

### Acceptance Criteria For Phase 4

- The remaining uncovered list is reduced to genuinely hard or intentionally deferred cases.
- Distribution tests prove actual distribution contracts, not just metadata shape.

## Phase 5: Review-Only Cases

### Objective

Use review-only traces only where executable verification is genuinely not the right tool.

### Rules

- Review-only tests must have names starting with `REVIEW: `.
- Review-only tests must include a short comment explaining the reasoning.
- Review-only traces must not be used as a shortcut for missing command, adapter, or protocol behavior.

### Likely appropriate uses

- repository-wide configuration policies
- code-review-only invariants that are not naturally executable

### Likely inappropriate uses

- remote transport behavior
- lifecycle command behavior
- registry mutation flows
- bundle/runtime parity

### Acceptance Criteria For Phase 5

- All review-only traces are clearly marked and justified.
- No high-risk executable behavior is covered only by review-only tests.

## Execution Order

The recommended implementation sequence is:

1. Add missing `traceSpec(...)` to already-covered tests.
2. Remove or narrow weak trace mappings.
3. Add remote-access command-path tests.
4. Add lifecycle command-path tests.
5. Add registry command-path tests.
6. Add distribution artifact and parity tests.
7. Re-run the full validation workflow.
8. Re-audit uncovered IDs and repeat until the remaining list is intentional and small.

## Validation Workflow

After each milestone, run:

```bash
npm test
npm run lint:types
npm run test:trace
```

Interpretation:

- `npm test` must remain green throughout.
- `npm run lint:types` must remain green throughout.
- `npm run test:trace` should fail only for genuinely uncovered spec IDs.
- As phases progress, the uncovered list should shrink in a way that matches the work completed.

## Acceptance Criteria

The overall effort is complete when:

- Every traced test maps to behavior it actually asserts.
- No traced identifier is satisfied only by a weaker neighboring test.
- High-risk command and adapter paths have executable tests.
- Review-only tests are explicit, rare, and justified.
- `npm run test:trace` is close enough to full signal quality that enabling it in CI is a realistic next step.

## Milestone Breakdown

### Milestone 1: Honest Traceability For Existing Tests

- Add `traceSpec(...)` to existing tests with clear behavioral coverage.
- Remove or narrow misleading trace declarations.
- Keep the uncovered list honest.

### Milestone 2: Remote-Access and Lifecycle Command Coverage

- Cover `connect`, `cp`, and lifecycle command-path behavior.
- Add the missing consistency, timeout, exit-code, and stale-resource tests.

### Milestone 3: Registry Command and Config Edge Coverage

- Cover `add`, `init`, `switch`, `rm --terminate`, instance-ID warning/failure behavior, and config-store edge cases.

### Milestone 4: Distribution Artifact and Parity Coverage

- Prove bundle shape, runtime usability, and parity between supported distribution forms.

### Milestone 5: CI Readiness Review

- Re-run the audit.
- Inspect the remaining uncovered IDs.
- Decide whether `npm run test:trace` is ready for CI enforcement or still needs targeted backfill.

## Deliverables

At the end of this effort, the repository should have:

- stronger and more honest `traceSpec(...)` usage
- fewer misleading trace declarations
- new integration tests for command and adapter behavior
- a much smaller uncovered identifier set
- a credible path to enabling `test:trace` in CI
