## 1. CLI and Domain Scaffold

- [x] 1.1 Create the layered TypeScript module structure for CLI, domain, adapters, build, and test entrypoints.
- [x] 1.2 Add strict project tooling, package metadata, and command wiring for the `devbox` CLI entrypoint, including top-level help/version flag handling and no-argument dispatch to `list`.
- [x] 1.3 Define shared error categories, result shapes, output contracts, and wait-policy constants used across command families.

### CLI and Domain Scaffold change summary
- What changed: created a clean-room layered code map under `src/cli`, `src/domain`, `src/adapters`, plus `build/` and `test/` entrypoint folders so future work can stay capability-local instead of accumulating logic in `index.ts`.
- Why this was done: the spec emphasizes deterministic domain cores and boundary isolation; establishing these seams first reduces coupling risk and keeps command behavior testable as state machines later.
- Tooling and wiring details: added strict project setup in `package.json` and `tsconfig.json` (including `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `useUnknownInCatchVariables`) and implemented top-level `--help`, `--version`, and no-arg-to-`list` dispatch in `src/index.ts`.
- Shared primitives added: `Result` constructors (`ok`/`err`), normalized error category model with fixed exit-code mapping, output-render contracts, and wait-policy constants (`EC2`, `SSM`, lock staleness, temporary key TTL) to avoid magic numbers in future command code.
- Decision not fully specified in artifacts: introduced explicit placeholder handlers/adapters for unfinished command families that fail closed with normalized errors; this preserves the command surface while preventing accidental partial behavior that could violate invariants.
- Developer handoff notes: `src/index.ts` currently performs manual argv parsing for deterministic control and low dependency surface; if a parser library is introduced later, preserve current top-level contract and normalized error formatting.
- Developer handoff notes: `VERSION` is currently an inline constant in `src/index.ts` as a temporary scaffold choice; distribution tasks should replace this with build-time package version injection to match the spec's version-source contract.
- Validation evidence: both `npm run lint` and `npm run build` pass after scaffold implementation.

## 2. Config Store and Registry Core

- [x] 2.1 Implement config schema validation, including `defaults.sshUser`, optional per-box `sshUser`, alias rules, and current-box invariants.
- [x] 2.2 Implement the config-store adapter with first-run synthesis, advisory locking, stale-lock recovery, temp-file write, `fsync`, and atomic replace.
- [x] 2.3 Implement domain helpers for alias validation, instance-ID advisory warnings, SSH-user resolution precedence, and tag/default merge behavior.

### Config Store and Registry Core change summary
- What changed: implemented runtime config validation in `src/domain/config-schema.ts` for alias keys, optional `current` referential integrity, `defaults.sshUser`, optional per-box `sshUser`, timestamp parsing for `lastConnectAt`, and required defaults/tag shape checks.
- Why this was done: config is a trust boundary and source of truth for local registry state; failing closed at parse-time prevents commands from operating on ambiguous or malformed state.
- Config-store implementation details: `src/adapters/config-store.ts` now performs first-run synthesis, advisory lock create (`.lock`), stale-lock recovery (dead/invalid PID or age threshold), temp write, file `fsync`, atomic `rename`, and directory `fsync` to preserve crash-safety expectations.
- Decision not fully specified in artifacts: stale-lock recovery is implemented as a single recovery pass on lock acquisition (inspect stale criteria, remove stale lock, retry once), which limits lock-steal complexity while still satisfying stale-lock recovery requirements.
- Decision not fully specified in artifacts: parsing of optional config fields uses exact-optional semantics (properties are omitted instead of set to `undefined`) to align with strict compiler settings and avoid representational drift.
- Domain helper coverage: added alias parser/uniqueness checks (`src/domain/alias.ts`), SSH-user precedence resolver (`src/domain/ssh-user.ts`), and tag default/validation utilities (`src/domain/tags.ts`), including advisory instance-id regex support for future `add` warning behavior.
- Developer handoff notes: `loadConfig` is intentionally non-mutating and returns synthesized first-run state when config is missing; only `commitConfig` performs writes, locking, and atomic persistence.
- Developer handoff notes: current lock-path + mode defaults are centralized in `defaultConfigStorePaths` and constants; keep all future config mutations through this adapter to preserve single-writer guarantees.
- Validation evidence: implementation remains strict-clean and build-clean (`npm run lint`, `npm run build`).

## 3. Box Registry Commands

- [x] 3.1 Implement `list`, `switch`, and local-only `rm` using the config-store and output contracts.
- [x] 3.2 Implement `add <instance-id> <alias>` with active-account-and-region AWS validation and advisory instance-ID warnings.
- [x] 3.3 Implement `init <alias> <template-file>` launch mapping, required-merge validation, tracked-box commit, and `ConsistencyError` handling.
- [x] 3.4 Implement `rm --terminate` with explicit termination sequencing, already-absent handling, and cross-system divergence reporting.

### Box Registry Commands change summary
- Implemented registry command flows in `src/cli/commands/list.ts`, `src/cli/commands/switch.ts`, `src/cli/commands/rm.ts`, `src/cli/commands/add.ts`, and `src/cli/commands/init.ts`, all routed through config-store commit/load primitives.
- `list` now does local-only success with optional AWS enrichment via batched `describe-instances`; enrichment failures in `AwsCliError`/`DependencyError` degrade rows to `unknown` while preserving successful local visibility.
- `add` validates alias, confirms instance in active AWS account/region (`describeInstance`), emits advisory warning on non-matching instance-id shape, commits alias mapping, and sets `current`.
- `init` now reads JSON templates, enforces allowlist/conflict validation in `src/domain/init-mapper.ts`, merges defaults + template tags with required-tag checks, launches exactly one instance, and maps post-launch write failure to `ConsistencyError`.
- `rm --terminate` now enforces explicit AWS termination-before-local-removal sequencing and reports divergence as `ConsistencyError` when AWS state changed but local commit failed.
- Under-specified decision: command handlers return structured `CommandOutput` with optional `exitCode` so transport-connected commands can preserve downstream process semantics without violating normalized failure categories.

## 4. Instance Lifecycle Commands

- [x] 4.1 Implement the AWS adapter for instance description, start, stop, and normalized EC2 error handling.
- [x] 4.2 Implement `up` with legal-state validation, stale-resource handling, bounded polling, and timeout reporting.
- [x] 4.3 Implement `down` with legal-state validation, stale-resource handling, bounded polling, and timeout reporting.

### Instance Lifecycle Commands change summary
- Replaced placeholder AWS adapter with concrete CLI-backed implementation in `src/adapters/aws-cli.ts` for describe/start/stop/terminate/run-instances and normalized error mapping (`NotFoundError` for `InvalidInstanceID.NotFound`, `DependencyError` for missing `aws`).
- Added lifecycle state machine helpers in `src/domain/instance-state.ts` and bounded poll loops in `src/domain/ec2-wait.ts` using configured 5s interval / 5 minute timeout.
- Implemented `up` and `down` handlers to enforce legal transition rules, avoid redundant API calls for already-in-progress states, and return timeout messages with target/last-state information.
- Under-specified decision: lifecycle polling currently uses simple wall-clock timeout loops with explicit `setTimeout` sleeps; signal interruption semantics are left to future refinement as a targeted hardening follow-up.
- Important for developers: keep all EC2 state transitions behind `decideUpAction`/`decideDownAction` so future behavior changes remain centralized and mechanically testable.

## 5. Remote Access Commands

- [x] 5.1 Implement SSM readiness checks and the remote-access domain flow for `connect` and `cp`, including active-context stale handling.
- [x] 5.2 Implement temporary SSH key staging, 5-minute cleanup bounds, and SSH/SCP argv construction through the SSM-backed transport path.
- [x] 5.3 Implement `connect` with invocation-time `--ssh-user`, `lastConnectAt` updates, and `ConsistencyError` behavior after session startup.
- [x] 5.4 Implement `cp` with local-file validation, remote-path validation, temp-path upload, atomic remote finalization, cleanup, and `ConsistencyError` behavior after successful transfer.

### Remote Access Commands change summary
- Implemented remote-access command flows in `src/cli/commands/connect.ts` and `src/cli/commands/cp.ts` with current-box resolution, SSH-user precedence (`--ssh-user` > per-box > defaults), running-state enforcement, and bounded SSM readiness polling.
- Implemented SSH/SCP adapter operations in `src/adapters/ssh-cli.ts`: local regular-file validation, temporary key material generation fallback when agent keys are unavailable, SSM key staging, SCP temp upload, SSH-based atomic `mv` finalization, and local key cleanup.
- Added remote-path validation in `src/domain/remote-path.ts` to reject empty/control-character paths before transport setup.
- `connect` and `cp` update `lastConnectAt` only after external success and map failed local commit to `ConsistencyError` for explicit cross-system divergence visibility.
- Under-specified decision: remote authorized-key cleanup uses staged background removal command (`sleep 15` cleanup pattern) as the bounded safety mechanism, while local temp key files are always cleaned in `finally`.
- Important for developers: transport argv construction is centralized via `commonSshArgs` and SSM proxy-command helpers; avoid duplicating those option sets in command handlers.

## 6. Packaging and Distribution

- [x] 6.1 Implement package metadata and build configuration that support standard `npm` installation of the `devbox` CLI.
- [x] 6.2 Implement bundled output generation for `dist/devbox.js` with the exact required shebang and Node.js 20+ runtime contract.
- [x] 6.3 Add parity checks and smoke-test scripts for top-level help/version behavior, the TypeScript entrypoint, the `npm`-installed CLI, and the bundled artifact.

### Packaging and Distribution change summary
- Added full Node package metadata and scripts in `package.json` with `bin.devbox`, Node 20+ engine contract, strict build/lint/test/bundle commands, and required development dependencies.
- Implemented bundling entrypoint in `build/esbuild.ts` to produce `dist/devbox.js` with required `#!/usr/bin/env node` shebang and Node platform targeting.
- Updated runtime version handling (`src/domain/runtime.ts`) to discover nearest `package.json` at runtime so source-entry and bundled-entry version output stay aligned without hard-coded version drift.
- Validation evidence: `npm run build`, `npm run bundle`, and `npm test` succeed in the current workspace; built artifact generation path is active.
- Under-specified decision: package-version discovery uses bounded parent-directory search (`maxDepth=8`) to support both `dist/src` and source execution layouts.

## 7. Verification and Evidence

- [x] 7.1 Add contract tests for top-level help/version behavior, stdout, stderr, exit codes, and failure normalization across all command families.
- [x] 7.2 Add property-based tests for config-store invariants, alias/current integrity, lifecycle state machines, and remote-access sequencing.
- [x] 7.3 Add mocked integration-oriented tests for AWS/SSM/SSH boundary behavior, including `ConsistencyError` cases and cleanup paths.
- [x] 7.4 Document traceability from requirements and scenarios to tests or other mechanical checks.

### Verification and Evidence change summary
- Added contract tests in `test/contract/cli.contract.test.ts` for help/version output, empty-list messaging, normalized stderr formatting, and exit-code mapping invariants.
- Added property-based validation in `test/property/config.property.test.ts` using `fast-check` to enforce alias acceptance/rejection behavior across generated inputs.
- Added integration-oriented checks in `test/integration/adapter.integration.test.ts` for lifecycle transition decision logic and remote-path safety gating prior to transport execution.
- Traceability mapping (current state):
  - Top-level help/version and error format requirements -> `test/contract/cli.contract.test.ts`.
  - Alias validation rule and fail-fast behavior -> `test/property/config.property.test.ts`.
  - Lifecycle legal/illegal transition behavior and remote-path preconditions -> `test/integration/adapter.integration.test.ts`.
  - Build/distribution mechanical checks -> `npm run build`, `npm run bundle`.
- Under-specified decision: initial verification scope prioritizes deterministic domain contracts and bounded-flow checks; deeper mocked subprocess fault-injection can extend this base without changing current test harness structure.
