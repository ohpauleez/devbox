# Architecture

This document is a codemap for `devbox`. It is aimed at contributors who need to answer two questions quickly:

- where does behavior for a given command or concern live?
- what architectural boundaries should not be crossed when changing the code?

`devbox` is a small TypeScript CLI for managing AWS EC2 development boxes. It intentionally stays a thin wrapper around external tools rather than becoming a full AWS client of its own. The core product model is simple:

- local config is the source of truth for tracked aliases and current-box selection
- AWS is the source of truth for live instance existence and instance state
- remote access is staged temporarily through SSM-backed SSH rather than long-lived hidden access state

The living design doc under `docs/design.md` is the durable design intent for the project and the main technical documenation. This file complements it by mapping that design onto the code that exists in this repository.

This project follows a lightweight formal methods approach defined in [`docs/lfm.md`](docs/lfm.md).
All code adheres to the style guide defined in [`docs/typescript_style.md`](docs/typescript_style.md).

## Overview

At the highest level, `devbox` uses a layered architecture that takes a CLI invocation, resolves local state, optionally queries AWS, and then either prints output or performs a bounded side effect.

```text
user invocation
    |
    v
src/index.ts
    |
    v
src/cli/commands/*
    |
    v
src/domain/* ------------------------------+
    |                                      |
    v                                      v
src/adapters/config-store.ts         src/adapters/aws-cli.ts
    |                                      |
    v                                      v
~/.config/devbox.json                 aws ec2 / aws ssm
                                           |
                                           v
                                      EC2 / SSM

src/cli/commands/connect.ts and cp.ts also use:
    src/cli/remote-access.ts -> src/adapters/ssh-cli.ts -> ssh / scp -> remote host
```

The important split is between deterministic decision-making in `src/domain/` and side effects in `src/adapters/`. Command handlers in `src/cli/commands/` are the layer that composes the two.

## Code Map

### Repository Roots

- `src/`: implementation code for the CLI, domain model, and side-effecting adapters
- `test/`: unit, contract, property, and integration tests
- `build/`: bundle build path for the single-file CLI artifact
- `openspec/`: proposals, designs, tasks, and capability specs for the core product behavior
- `docs/`: project-wide guidance, especially `docs/typescript_style.md` and `docs/lfm.md`

### `src/index.ts`

`src/index.ts` is the entrypoint.

This is the place to start when you want to understand top-level CLI behavior:

- raw argv parsing
- dispatch to a command handler
- top-level `--help` and `--version` fast paths
- final stdout/stderr writing
- mapping structured errors to fixed process exit codes

If you need to add a new command, change parsing rules, or adjust the global CLI contract, start here.

### `src/cli/`

`src/cli/` is the application layer. It translates parsed invocations into calls into the domain and adapter layers.

#### `src/cli/commands/`

This directory is organized primarily by command surface:

- `list.ts`: reads tracked boxes from local config and optionally enriches them with live AWS state
- `init.ts`: validates launch input, launches a new EC2 instance, and records it locally
- `add.ts`: starts tracking an already-existing EC2 instance under an alias
- `rm.ts`: removes local tracking, and optionally requests termination before removing the alias
- `switch.ts`: changes the current selected alias without contacting AWS
- `up.ts`: ensures the current instance reaches `running`
- `down.ts`: ensures the current instance reaches `stopped`
- `connect.ts`: establishes an interactive SSH session to the current box after the remote-access preconditions are satisfied
- `cp.ts`: uploads a local file to the current box using the same remote-access path

The command handlers are the best place to look when you are asking “where is the end-to-end flow for command X?”.

#### `src/cli/remote-access.ts`

This module is shared infrastructure for `connect` and `cp`.

It centralizes the precondition chain for remote access:

- load config
- resolve current box
- resolve SSH user
- verify the EC2 instance exists and is running
- wait for SSM readiness
- ensure local SSH key material exists
- stage temporary remote SSH authorization

If remote-access behavior changes, start here before touching `connect.ts` or `cp.ts`.

#### `src/cli/context.ts`

This is a small type-only seam defining the command result contract used by dispatch. It is not complex, but it is part of the glue that keeps the CLI layer consistent.

### `src/domain/`

`src/domain/` is the deterministic core of the program. These modules should be readable as business rules and state rules, not as subprocess orchestration.

This directory is where most architectural invariants live.

#### Registry and Config Domain

- `config-schema.ts`: validates, parses, serializes, and synthesizes the on-disk config model
- `alias.ts`: alias syntax and alias-availability rules
- `context.ts`: resolves the current tracked box from validated config
- `ssh-user.ts`: SSH-user precedence rules
- `tags.ts`: required tag defaults and tag validation logic
- `types.ts`: core domain types used across layers

If you are changing what a valid config looks like, or what counts as a valid alias or SSH user, look here first.

#### Launch, Lifecycle, and Remote-Access Domain

- `init-mapper.ts`: maps launch-template-style JSON plus defaults into a validated `run-instances` request shape
- `instance-state.ts`: legal EC2 state transitions and invalid-state decisions for `up` and `down`
- `ec2-wait.ts`: bounded waiting for EC2 and SSM conditions
- `ssm-readiness.ts`: SSM-related readiness rules and vocabulary
- `remote-path.ts`: remote-path validation for `cp`
- `wait-policy.ts`: timeout and polling constants, plus the clock abstraction used in tests

If you are changing what `up`, `down`, `connect`, or `cp` are allowed to do, these modules are usually more important than the adapters.

#### Output and Error Contracts

- `errors.ts`: stable error categories, exit code mapping, and normalized stderr rendering
- `output-contracts.ts`: stdout/stderr rendering for help, version, list output, and common output shapes
- `result.ts`: the Result type used to keep failures explicit rather than exception-driven
- `runtime.ts`: runtime discovery of package version metadata
- `assert.ts`: assertion helpers used to make invariants explicit in code

These modules define the public CLI contract more than any individual command file does.

### `src/adapters/`

`src/adapters/` is where the program touches the outside world.

The rule of thumb is: if a module needs filesystem writes, subprocess execution, or remote effects, it belongs here or should pass through here.

#### `src/adapters/config-store.ts`

This is the persistence boundary for local state.

It owns:

- config file path resolution
- first-run behavior when config is missing
- lock-file acquisition and stale-lock recovery
- temp-file write, `fsync`, atomic rename, and directory sync

If you need to change how config is stored or mutated, this is the only place that should write it.

#### `src/adapters/aws-cli.ts`

This is the AWS boundary.

It shells out to `aws` and normalizes the results into domain-friendly values. It currently covers the EC2 and SSM operations used by the CLI, such as:

- describing instances
- starting, stopping, and terminating instances
- launching instances
- checking SSM status

This module should know about AWS CLI invocation details. The rest of the program should mostly know about typed results and failure categories.

#### `src/adapters/ssh-cli.ts`

This is the SSH/SCP boundary for `connect` and `cp`.

It owns:

- local SSH key material selection or generation
- temporary key staging on the remote machine
- SSH/SCP argv construction for SSM-backed transport
- interactive SSH startup
- SCP upload and cleanup helpers
- local temp-key cleanup, including signal-aware cleanup support

If remote transport behavior changes, this is the main boundary to inspect.

#### `src/adapters/process.ts`

This is the lowest-level subprocess adapter.

Its main job is to keep process execution argv-based rather than shell-based. That matters because a large part of the project’s safety story depends on avoiding shell interpolation of user-controlled values.

### `build/`

- `build/esbuild.ts`: builds the single-file `dist/devbox.js` artifact

This is intentionally small. Packaging is part of the product contract, but most runtime semantics still live in `src/index.ts` and the command/domain layers.

### `test/`

The tests are split by boundary rather than by source directory.

#### `test/contract/`

These tests check stable contracts and normalization rules:

- help/version output
- error formatting and exit-code mapping
- config parsing expectations
- init-mapper rules
- output formatting
- remote-access and instance-state contracts

If you are changing a user-visible contract, these are the tests most likely to need updates.

#### `test/property/`

These tests check generated histories and invariants, especially with `fast-check`.

This is where the repository encodes its “lightweight formal methods” posture most directly. Representative concerns here include:

- alias tracking invariants
- config-store behavior
- lifecycle state-machine behavior
- remote-path validation
- SSH-user precedence

If you are changing a state machine or an invariant, this directory matters at least as much as the command tests.

#### `test/integration/`

These tests sit at the seams between layers:

- command-flow integration
- adapter behavior
- config-store persistence behavior
- EC2 wait-loop behavior
- build and package checks

They are useful when you need confidence that several modules still compose correctly after a change.

#### `test/fixtures/`

Shared test assets live here when needed.

## Command Families

The commands fall into a few useful groups.

### Informational Commands

- `--help`
- `--version`

These are pure output paths. They should not need config, AWS, or remote-access setup.

### Box Registry Commands

- `list`
- `init`
- `add`
- `rm`
- `switch`

These commands are mostly about local tracking state, with AWS involvement where necessary to create, validate, or destroy the external instance relationship.

### Lifecycle Commands

- `up`
- `down`

These commands are about reconciling the current box with the desired EC2 power state using bounded polling and explicit invalid-state handling.

### Remote-Access Commands

- `connect`
- `cp`

These commands cross the most boundaries at once: local config, AWS state, SSM readiness, SSH key staging, local SSH tooling, and the remote host.

## Architecture Invariants

These are the most important things to preserve when changing the code.

### Source-of-Truth Boundaries

- The local config is the source of truth for tracked aliases and `current` selection.
- AWS is the source of truth for whether a tracked instance actually exists and what state it is in.
- The code should not persist guessed live instance state and then trust it later.

### Layer Boundaries

- `src/domain/` should contain deterministic rules and state reasoning, not direct subprocess or filesystem behavior.
- `src/adapters/` should contain boundary-specific mechanics and normalization, not core decision-making.
- `src/cli/commands/` should compose domain logic and adapters rather than reimplementing shared rules inline.

### Config Mutation Rules

- All config writes go through `src/adapters/config-store.ts`.
- `current` is absent or points to an existing alias.
- Failed local mutations must not leave partially committed config state.
- Single-writer semantics matter more than convenience here.

### Error and Output Rules

- Errors should be expressed as structured `DevboxError` values and rendered in normalized form.
- Exit codes are a stable contract
- If a command succeeds externally but fails to update local state afterward, the result should remain visible as a consistency problem rather than being collapsed into a generic local failure.

### AWS Boundary Rules

- `devbox` is intentionally a thin wrapper around `aws`, not an SDK-driven client.
- Help/version and other local-only flows should not accidentally require AWS access.
- `list` should degrade gracefully when AWS enrichment is unavailable.

### Remote-Access Rules

- `connect` and `cp` operate only on the current box.
- Remote access requires a running instance and bounded SSM readiness.
- Temporary SSH authorization must be staged and cleaned up rather than silently becoming permanent.
- `lastConnectAt` is updated only after external success and local commit success.

### Destructive-Action Rules

- Destructive AWS effects must stay explicit.
- `rm` without `--terminate` is a local registry operation.
- `rm --terminate` must not remove local tracking before AWS accepts the termination path.

## Cross-Cutting Concerns

### Error Normalization

The project uses explicit, tagged error categories instead of free-form exceptions. This matters because the CLI contract is defined in terms of:

- fixed error categories
- fixed exit codes
- predictable stderr formatting

When adding a new failure path, the first question is usually not “what message should we throw?” but “which existing category is this, and is this boundary the right place to normalize it?”

### Bounded Work

Long waits are treated as first-class behavior, not hidden implementation details. Polling budgets and timing constants live in the domain layer so that lifecycle and remote-access waits remain visible and testable.

### Packaging Parity

The project supports both the compiled CLI entrypoint and a bundled single-file artifact. Packaging is part of the product contract, so build behavior is tested rather than treated as a separate release concern.

### Verification Style

The tests are intentionally split across contract, property, and integration boundaries. The important idea is not just “have tests”, but “put tests at the seams where invariants can be checked mechanically”.

The OpenSpec change and `docs/lfm.md` provide the rationale; the `test/` tree shows how that approach is applied in code.

## Relationship To OpenSpec

This project uses spec-driven development with OpenSpec (using the [srs-driven schema](github.com/ohpauleez/openspec_srs-driven)) to make changes.

For product intent, start in `openspec/`:

- `proposal.md`: problem statement, command set, invariants, and failure categories
- `design.md`: layered architecture, state-machine framing, and component responsibilities
- `tasks.md`: implementation breakdown and change history
- `specs/*`: capability-specific requirements for registry, lifecycle, remote access, and distribution

Use this `ARCHITECTURE.md` when you need to know where a change belongs in the code. Use the OpenSpec change when you need to know what behavior the code is supposed to preserve.

### spec.md

All spec.md files define the system's verifiable behavior using EARS format and RFC 2119 keywords:

| Pattern           | Template                                                               | When to use                    |
|-------------------|------------------------------------------------------------------------|--------------------------------|
| Ubiquitous        | `THE <system> SHALL <response>.`                                       | Always active                  |
| State-driven      | `WHILE <precondition>, THE <system> SHALL <response>.`                 | Active in a continuous state   |
| Event-driven      | `WHEN <trigger>, THE <system> SHALL <response>.`                       | Discrete event causes behavior |
| Unwanted-behavior | `IF <trigger>, THEN THE <system> SHALL <response>.`                    | Error/failure mitigation       |
| Complex           | `WHILE <precondition>, WHEN <trigger>, THE <system> SHALL <response>.` | Both state and event required  |
| Optional          | `WHERE <feature is included>, THE <system> SHALL <response>.`          | Optional/configurable behavior |

RFC 2119: SHALL/MUST = absolute requirement, SHOULD = recommended, MAY = optional.

Escape hatch: When a requirement has more than 3 preconditions or is mathematical/tabular,
it MAY use decision tables, lists, or other formats. The requirement MUST include a
justification for why EARS is insufficient.

Specs are all traceable through the code and tests using [spec-traceability](docs/spec_traceability.md).
Test tooling ensures that all specs are covered by tests.

### Existing Specs

- [box-registry](/openspec/specs/box-registry/spec.md) - Defines the local box-registry behavior for `devbox`: tracking named EC2 development machines, selecting the current box, listing tracked boxes, and handling `init`, `add`, `rm`, and `switch` with local config as the durable source of truth.
- [distribution](/openspec/specs/distribution/spec.md) - Defines the supported distribution contracts for `devbox` so the CLI can be installed through `npm` and shipped as a bundled `dist/devbox.js` artifact while preserving the same user-visible behavior, help/version surface, outputs, exit codes, and Node.js runtime expectations.
- [instance-lifecycle](/openspec/specs/instance-lifecycle/spec.md) - Defines the lifecycle-control behavior for the current tracked `devbox` machine, with the active AWS account and region treated as authoritative for live state.
- [remote-access](/openspec/specs/remote-access/spec.md) - Defines the remote-access behavior for `devbox connect` and upload-only `devbox cp` over AWS SSM-backed SSH, including invocation-time SSH-user overrides, readiness checks, remote-path safety, temporary key staging, bounded cleanup, and post-success consistency handling.
- [spec-traceability](/openspec/specs/spec-traceability/spec.md) - Defines the OpenSpec traceability behavior for the repository's TypeScript/Vitest test harness: discovering canonical identifiers from included OpenSpec specs, validating explicit `traceSpec(...)` declarations in tests, reporting provenance-aware diagnostics, and enforcing full-catalog coverage in a dedicated full-suite mode.
