# devbox

`devbox` is a small TypeScript CLI for creating, tracking, starting, stopping, connecting to, and uploading files to AWS EC2 development machines.

It is intentionally narrow: `devbox` is a thin wrapper around `aws`, `ssh`, and `scp`, not a general-purpose control plane. Local config is the source of truth for tracked aliases, AWS is the source of truth for live instance state, and remote access is staged temporarily over SSM-backed SSH.

Canonical project docs:
- [Technical design](docs/design.md)
- [Architecture codemap](ARCHITECTURE.md)
- [Lightweight formal methods](docs/lfm.md)
- [TypeScript style guide](docs/typescript_style.md)
- [OpenSpec capability specs](openspec/specs/)

## Overview

`devbox` exists to replace repetitive, error-prone AWS CLI workflows with a smaller set of explicit, bounded commands.

At a high level it supports:
- local box registry management: `list`, `init`, `add`, `rm`, `switch`
- EC2 lifecycle control: `up`, `down`
- remote access: `connect`, `cp`
- distribution parity across the npm-installed CLI and the bundled artifact

For the full design rationale, see [docs/design.md](docs/design.md).

## Runtime And Tooling

Runtime requirements:
- Node.js `>= 20` ([package.json](package.json))
- `npm`
- AWS CLI configured outside `devbox`
- `ssh`, `scp`, and either `ssh-agent` or `ssh-keygen` for remote access

Notes:
- `devbox` does not manage AWS credentials, profiles, or regions for you.
- Local registry state is stored in `~/.config/devbox.json`.

Build and packaging:
- compiled CLI entrypoint: `dist/src/index.js`
- bundled single-file artifact: `dist/devbox.js`
- See the [docs/design.md](docs/design.md) or [distribution spec](openspec/specs/distribution/spec.md) for more details

## Usage

Basic form:

```sh
devbox [command]
```

### `devbox` commands

| Command | Purpose |
|---|---|
| `devbox [-v | --version | -h | --help]` | List info or tracked boxes if arg-less|
| `devbox list` | List tracked boxes |
| `devbox init <alias> <template-file>` | Launch and track a new instance |
| `devbox add <instance-id> <alias>` | Track an existing instance |
| `devbox rm <alias> [--terminate]` | Remove a tracked alias, optionally terminating the instance |
| `devbox switch <alias>` | Set the current alias |
| `devbox up` | Start the current instance |
| `devbox down` | Stop the current instance |
| `devbox connect [--ssh-user <user>]` | Connect to the current instance |
| `devbox cp [--ssh-user <user>] <local> <remote>` | Upload one local file to the current instance |
| `devbox --help` | Show help |
| `devbox --version` | Show version |

## Makefile

The top-level [Makefile](Makefile) is the main convenience entrypoint.
The default target is `check`, so plain `make` runs the full local verification pipeline.

| Target | What it does |
|---|---|
| `make tooling` | Download additional verification tooling to `./tooling/` |
| `make format` | Force uniform style / lint fixes |
| `make check` | Run lint, build, and all tests (with spec-tracing enabled) |
| `make test` | Run the test suite (with spec-tracing disabled) |
| `make dist` | Build all distribution artifacts |
| `make run [args...]` | Run the compiled CLI via `node ./dist/src/index.js` |
| `make clean` | Remove `./dist` |

## Architecture

The main repository areas are:
- [src/](src/) - implementation code
- [src/index.ts](src/index.ts) - CLI entrypoint and dispatch
- [src/cli/commands/](src/cli/commands/) - end-to-end command flows
- [src/cli/remote-access.ts](src/cli/remote-access.ts) - shared remote-access precondition chain
- [src/domain/](src/domain/) - deterministic domain logic, validation, state machines, and errors
- [src/adapters/](src/adapters/) - filesystem, subprocess, AWS CLI, and SSH/SCP boundaries
- [test/](test/) - unit / contract, property, and integration tests
- [build/](build/) - build and bundling scripts
- [openspec/](openspec/) - proposals, tasks, and normative capability specs
- [docs/](docs/) - design and engineering guidance

The architectural rule of thumb is:
- `src/domain/` owns rules and invariants
- `src/adapters/` owns side effects
- `src/cli/commands/` composes the two

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codemap and architectural boundaries.

## Lightweight Formal Methods

This project explicitly uses lightweight formal methods to increase confidence without aiming for a proof of the whole system.

In practice that means:
- identifying critical properties and invariants first
- modeling key workflows as state machines
- keeping the core deterministic and pushing nondeterminism to the edges
- using layered evidence: specs, models, property tests, contract tests, integration tests, and traceability

Relevant references:
- [docs/lfm.md](docs/lfm.md)
- [docs/design.md](docs/design.md)
- [spec traceability](docs/spec_traceability.md)

## Style Guide

Code in this repository follows the guidance in [docs/typescript_style.md](docs/typescript_style.md).

Key expectations include:
- invariants-first design
- deterministic systems and explicit state machines
- simple, bounded control flow
- `Result`-style error handling for expected failures
- strong boundary validation
- strict TypeScript and zero normalized lint debt
- complete TSDoc for public code

## Canonical Documents

Start here depending on what you need:
- product and behavior overview: [docs/design.md](docs/design.md)
- code layout and change boundaries: [ARCHITECTURE.md](ARCHITECTURE.md)
- assurance and verification posture: [docs/lfm.md](docs/lfm.md)
- coding rules and review expectations: [docs/typescript_style.md](docs/typescript_style.md)
- normative requirements: [openspec/specs/](openspec/specs/)

Primary capability specs:
- [box-registry](openspec/specs/box-registry/spec.md)
- [instance-lifecycle](openspec/specs/instance-lifecycle/spec.md)
- [remote-access](openspec/specs/remote-access/spec.md)
- [distribution](openspec/specs/distribution/spec.md)
- [spec-traceability](openspec/specs/spec-traceability/spec.md)

### License

<sup>
Licensed under either of <a href="LICENSE-APACHE">Apache License, Version
2.0</a> or <a href="LICENSE-MIT">MIT license</a> at your option.
</sup>

<br>

<sub>
Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this crate by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.
</sub>

