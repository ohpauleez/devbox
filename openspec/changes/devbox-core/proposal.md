## Motivation

`devbox` exists to give developers a simple, dependable CLI for creating and managing multiple AWS EC2 development environments without forcing them to work directly with raw AWS CLI commands for every routine action.

The initial specification is needed now because the project has prior notes and prototypes, but no durable, standalone OpenSpec artifact set that cleanly defines the product behavior, critical invariants, failure handling, and verification obligations. The initial change turns the existing design intent into a rigorous specification package that can drive implementation and evidence production.

## Scope

### In Scope
- Define the core `devbox` CLI behavior for tracking named EC2 development machines, selecting a current machine, and listing tracked machines.
- Define box-creation and tracking flows for `init`, `add`, `rm`, and `switch`.
- Define lifecycle control for starting and stopping the current tracked machine with bounded polling and explicit stale-resource behavior.
- Define remote-access behavior for `connect` and upload-only `cp` over AWS SSM with temporary SSH key staging, bounded cleanup, and explicit SSH-user resolution rules.
- Define the local configuration model, including tracked boxes, current selection, built-in defaults, `defaults.sshUser`, and optional per-box `sshUser` overrides supplied only by manual config edits in v1.
- Define output contracts, error categories, exit codes, cross-system consistency rules, and the thin-wrapper boundary around AWS CLI, SSM, and local OpenSSH tools.
- Define supported distribution behavior for `npm` installation and a bundled single-file `dist/devbox.js` artifact with equivalent CLI behavior.
- Define the evidence expectations for the initial implementation, including explicit invariants, state-machine-oriented requirements, property-based verification, and command contract tests.

### Out of Scope
- Managing AWS profiles, credentials, or region selection inside `devbox`.
- Persisting AWS account or region metadata per box.
- Dedicated CLI commands for editing per-box SSH-user overrides.
- Download workflows, directory copies, sync operations, or transfer protocols beyond upload-only `cp`.
- Replacing the AWS CLI with the AWS SDK.

## Context

### Background
Devbox is intended to be a small TypeScript CLI utility for creating and managing AWS EC2 development machines. Existing material in `pasture/plan_with_sshkeys.md` captures the core command set, invariants, error model, and design direction, but those materials are provisional and must not become the long-term specification source.
This specification change creates a standalone OpenSpec change set that is more robust, more detailed, and suitable as the project's durable specification baseline.

The product is intentionally narrow. It shells out to `aws ec2`, `aws ssm`, `ssh`, and `scp`; stores local tracking state in a single config file; and emphasizes explicit safety rules, bounded waits, deterministic domain logic, and minimal dependencies.

### Core Commands Overview
- `devbox -v` or `devbox --version`: Print version information and exit successfully.
- `devbox -h` or `devbox --help`: Print a command overview and help information together with version information, then exit successfully.
- `devbox` or `devbox list`: Show tracked boxes from local config and, when AWS is available, enrich them with live instance state and instance type.
- `devbox init <alias> <template-file>`: Create one new EC2 development machine from launch-template-style JSON, start tracking it locally, and select it as the current box.
- `devbox add <instance-id> <alias>`: Start tracking an already-existing EC2 instance in the active AWS account and region under a local alias.
- `devbox rm <alias> [--terminate]`: Remove local tracking for an alias, with optional explicit EC2 termination.
- `devbox switch <alias>`: Change the current selected box without contacting AWS.
- `devbox up`: Ensure the current tracked instance reaches `running`, starting it when necessary.
- `devbox down`: Ensure the current tracked instance reaches `stopped`, stopping it when necessary.
- `devbox connect`: Open an interactive SSH session to the current tracked instance through AWS SSM using temporary staged SSH authorization.
- `devbox cp <local> <remote>`: Upload one regular local file to the current tracked instance through the same staged SSM-backed SSH access path.

At a product level, the commands fall into four classes:
- top-level informational flags: `-v`, `--version`, `-h`, `--help`
- local-only commands: `switch`, `rm` without `--terminate`
- local-first commands with optional AWS enrichment: `list`
- AWS-dependent commands: `init`, `add`, `up`, `down`, `connect`, `cp`, `rm --terminate`

### Affected Systems and Stakeholders
- AWS EC2 and AWS Systems Manager as external systems used to create, inspect, start, stop, and access tracked machines.
- Local workstation tooling, especially Node.js, the AWS CLI, Session Manager support, OpenSSH tools, and the local filesystem used for config persistence.

### Assumptions and Dependencies
- Users manage AWS credentials, profile selection, and region selection outside of `devbox`.
- The active AWS account and region at command time determine whether tracked instance IDs are valid or stale.
- AWS-dependent commands require a working local `aws` CLI, valid AWS credentials, and sufficient IAM permissions.
- `connect` and `cp` depend on SSM session capabilities and the local executables needed for SSH-based access.
- The local filesystem supports the config-write strategy needed for single-writer, atomic replacement semantics.
- The target instances are configured so that the selected SSH user can be used for the temporary SSH-access workflow when remote access is requested.

### Constraints
- The utility must remain a thin wrapper over AWS CLI and local SSH tooling rather than introducing the AWS SDK.
- The codebase must strongly conform to the repository TypeScript style guide, especially around deterministic cores, explicit invariants, bounded work, and result-oriented failures.
- The local config path is fixed and forms the durable user-facing registry of tracked boxes.
- The specification must stand on its own and must not rely on direct references to prototype artifacts in `pasture`.
- The initial evidence strategy uses lightweight formal methods in the form of explicit invariants, state-machine-oriented specifications, and mechanical verification through tests rather than a separate theorem-proving or model-checking artifact.

### References
- `pasture/spec-kickoff.md`
- `docs/lfm.md`
- `docs/typescript_style.md`
- `openspec/schemas/srs-driven/schema.yaml`
- `openspec/schemas/srs-driven/templates/proposal.md`
- `openspec/schemas/srs-driven/templates/spec.md`
- `openspec/schemas/srs-driven/templates/design.md`
- `openspec/schemas/srs-driven/templates/tasks.md`

## Domain Model

The domain consists of a local registry of named development machines and the AWS resources those names refer to.

- **Box Alias**: A user-chosen stable local name for a tracked development machine.
- **Tracked Box**: A local record that binds a box alias to an EC2 instance ID and optional metadata such as the last successful remote-access time and an optional per-box SSH user override.
- **Current Box**: The single tracked box selected as the default target for commands that operate without an explicit alias parameter.
- **Defaults**: Shared configuration values used to create or access boxes, including required tag defaults and a default SSH user.
  - `defaults.tags`: A string-keyed, string-valued object with required keys: `env`, `service`, `version`, `customer-data`, `team`.
  - `defaults.ImageId`: An optional AMI identifier or SSM parameter resolve expression.
  - `defaults.IamInstanceProfile`: An optional IAM instance profile object.
- **Launch Template Input**: A user-provided launch-template-style JSON document used as input to create a new EC2 instance.
- **AWS Instance**: The live EC2 machine identified by the tracked instance ID and observed through the active AWS account and region.
- **Remote Access Session**: A bounded interaction that temporarily stages SSH access through AWS SSM for connection setup or file transfer.

Conceptual relationships:

```text
Defaults ───────────────┐
                        │
                        ▼
                 Tracked Box ───────────▶ AWS Instance
                     ▲   │                    ▲
                     │   │                    │
                     │   └── uses ───────▶ Remote Access Session
                     │
Box Alias ───────────┘

Current Box selects at most one Tracked Box.
Launch Template Input is used to create a new Tracked Box and AWS Instance pair.
```

## Preconditions, Postconditions, and Invariants

### Global

Preconditions:
- The process can access the user's home directory and the fixed local config path when a command needs local state.
- Config, if present, is valid JSON matching the documented schema.
- AWS-dependent commands run with the user-selected AWS account, credentials, and region already established in the environment outside of `devbox`.

Postconditions:
- Successful mutating local commands leave a schema-valid config at the fixed config path.
- Successful AWS-affecting commands either preserve local/AWS consistency or report divergence explicitly when the external operation succeeded but the local commit failed.
- Supported distribution forms expose the same user-visible command behavior, exit codes, and output contracts.

Invariants:
- The local config is the source of truth for tracked aliases and current-box selection.
- AWS is the source of truth for live instance existence and state in the active account and region.
- `current` is absent or names an existing tracked box.
- Alias keys are unique within the local registry.
- Destructive AWS effects occur only through explicit command paths that permit them.
- Failed local mutations do not leave partially committed config state.
- `devbox` does not assume ownership of AWS profile or region management.

### `devbox -v` / `devbox --version`

Preconditions:
- None beyond being able to execute the CLI entrypoint.

Postconditions:
- The command prints version information and exits successfully.
- The command does not mutate config state or contact AWS.

Invariants:
- Version reporting is a local CLI behavior independent of box selection and AWS context.

### `devbox -h` / `devbox --help`

Preconditions:
- None beyond being able to execute the CLI entrypoint.

Postconditions:
- The command prints command overview and help information together with version information and exits successfully.
- The command does not mutate config state or contact AWS.

Invariants:
- Help reporting is a local CLI behavior independent of box selection and AWS context.

### `devbox` / `devbox list`

Preconditions:
- No AWS dependency is required to list locally tracked aliases.
- Missing config is treated as empty state rather than a first-run failure.

Postconditions:
- The command reports tracked aliases from local config.
- When AWS enrichment is available, the command may show live instance state and instance type for tracked boxes.
- Output format is a human-readable terminal table with columns: current-box indicator, alias, instance ID, instance type, and state. State values include `running`, `stopped`, `pending`, `stopping`, `shutting-down`, `terminated`, `stale`, and `unknown`.
- The command does not mutate config state.

Invariants:
- Only locally tracked aliases are listed.
- Failure to enrich from AWS does not remove local visibility into tracked aliases.

### `devbox init <alias> <template-file>`

Preconditions:
- The alias is valid and unique.
- The template file exists, is readable, and contains valid launch-template-style JSON.
- Required launch values such as `ImageId`, `IamInstanceProfile`, and required tags are present after merge.
- The caller's active AWS context permits EC2 instance creation.

Postconditions:
- Exactly one EC2 instance is created on success.
- `boxes[alias].instanceId` is recorded locally and `current` is set to the alias.
- Validation failures prevent any AWS mutation.

Invariants:
- `init` creates tracked instances directly through `run-instances` rather than creating AWS launch template resources.
- The alias overrides the instance `Name` tag.

### `devbox add <instance-id> <alias>`

Preconditions:
- The alias is valid and unique.
- The instance is describable in the active AWS account and region.

Postconditions:
- The alias is added to local tracking and becomes the current box.
- Advisory instance-ID format mismatches may produce warnings, but AWS describe remains authoritative.

Invariants:
- Existing tracked aliases are preserved except for the documented `current` update.
- `add` does not create or mutate AWS resources.

### `devbox rm <alias> [--terminate]`

Preconditions:
- The alias exists in local tracking.
- If `--terminate` is supplied, the active AWS context permits termination of the tracked instance.

Postconditions:
- Without `--terminate`, the alias is removed locally and `current` is cleared if necessary. When `current` is cleared, it becomes absent (removed from config) rather than reassigned to another box.
- With `--terminate`, AWS termination is requested first and local tracking is removed only after AWS accepts termination or reports the instance already absent.

Invariants:
- Termination is never implicit.
- Removing one alias does not mutate unrelated aliases.

### `devbox switch <alias>`

Preconditions:
- The alias exists in local tracking.

Postconditions:
- `current` is updated to the selected alias.
- No AWS interaction is required.

Invariants:
- `current` always refers to an existing tracked alias.

### `devbox up`

Preconditions:
- `current` is set and resolves to a tracked instance ID.
- The tracked instance is describable in the active AWS account and region.
- The starting instance state is not `shutting-down` or `terminated`.

Postconditions:
- If the instance is `stopped`, the command submits a start request and waits for `running`.
- If the instance is already `pending`, the command waits for `running` without submitting a second start request.
- If the instance is already `running`, the command succeeds without changing state.

Invariants:
- Only the current tracked instance is targeted.
- `up` never submits an invalid start transition.

### `devbox down`

Preconditions:
- `current` is set and resolves to a tracked instance ID.
- The tracked instance is describable in the active AWS account and region.
- The starting instance state is not `shutting-down` or `terminated`.

Postconditions:
- If the instance is `running`, the command submits a stop request and waits for `stopped`.
- If the instance is already `stopping`, the command waits for `stopped` without submitting a second stop request.
- If the instance is already `stopped`, the command succeeds without changing state.

Invariants:
- Only the current tracked instance is targeted.
- `down` never submits an invalid stop transition.

### `devbox connect`

Preconditions:
- `current` is set and resolves to a tracked instance ID.
- The tracked instance is in EC2 state `running` and becomes SSM-ready within the documented bound.
- Required local executables and AWS SSM session prerequisites are present.
- An SSH user can be resolved from invocation override, per-box override, or `defaults.sshUser`.

Postconditions:
- The command starts an SSM-backed SSH session to the current tracked instance.
- The SSH session process replaces or is waited on by the `devbox` process; the exit code of `devbox connect` is the exit code of the SSH session.
- `lastConnectAt` is updated only after session startup succeeds and the subsequent local config write succeeds.

Invariants:
- Only the current tracked instance is targeted.
- Failed connection attempts do not update `lastConnectAt`.
- Remote-access setup uses temporary SSH authorization with bounded cleanup rather than long-lived unmanaged access.

### `devbox cp <local> <remote>`

Preconditions:
- `current` is set and resolves to a tracked instance ID.
- The tracked instance is in EC2 state `running` and becomes SSM-ready within the documented bound.
- The local source is a readable regular file. There is no enforced file size limit — SCP and network bandwidth are the natural constraints.
- The remote path is non-empty after trimming and contains no ASCII control characters or null bytes.
- Required local executables and AWS SSM session prerequisites are present.
- An SSH user can be resolved from invocation override, per-box override, or `defaults.sshUser`.

Postconditions:
- The file is uploaded to a temporary path first and moved into the final destination only after successful transfer.
- `lastConnectAt` is updated only after transfer completion succeeds and the subsequent local config write succeeds.
- The local source file is never modified.

Invariants:
- Only the current tracked instance is targeted.
- Failed transfer attempts do not partially rewrite the final remote destination path.
- Failed transfer attempts do not partially rewrite committed local config state.

## Failure Modes

### Global

- **Invalid or unreadable config**: The local config is malformed, violates the schema, or cannot be read when required.
  - **Rationale**: Local tracking is the source of truth for aliases and current selection, so commands must fail clearly rather than operate on untrusted state.
- **Dependency unavailable**: Required local executables, AWS credentials, AWS region context, or SSM session prerequisites are missing.
  - **Rationale**: The CLI intentionally relies on external tools and user-managed AWS context, so missing prerequisites must produce stable, actionable failures.
- **Config divergence after external success**: AWS state or remote-instance state changes successfully, but the subsequent local config update fails.
  - **Rationale**: This is the core cross-system consistency risk in the product and must be surfaced explicitly rather than hidden as an ordinary local write failure.
- **Concurrent local mutation conflict**: A live local writer already holds the config lock and the mutation cannot safely proceed.
  - **Rationale**: The product depends on single-writer local mutation semantics to prevent partial writes and ambiguous merge behavior.

### `devbox` / `devbox list`

- **Invalid config prevents local listing**: The command cannot trust the local registry because the config is invalid.
  - **Rationale**: Listing must never invent or guess local tracking state when the stored registry is unreadable or malformed.
- **AWS enrichment unavailable**: AWS lookup fails because AWS is unavailable, the executable is missing, or the active context is not usable.
  - **Rationale**: `list` should still provide local visibility into tracked aliases even when live enrichment cannot be completed.

### `devbox init <alias> <template-file>`

- **Invalid launch input**: Alias validation, template parsing, launch-template compatibility checks, required-merge rules, or tag rules fail before instance creation.
  - **Rationale**: Invalid launch requests must be rejected before AWS mutation so the tool does not create unintended infrastructure.
- **AWS launch failure**: EC2 rejects the create request or the active context does not permit instance creation.
  - **Rationale**: Instance creation is one of the most important state-changing operations, so AWS refusal must leave local tracking unchanged and clearly reported.
- **Post-launch local divergence**: EC2 launches successfully but local tracking cannot be committed afterward.
  - **Rationale**: Users must be told that infrastructure now exists even though local tracking may be missing or stale.

### `devbox add <instance-id> <alias>`

- **Undescribable instance ID**: The supplied instance cannot be described in the active AWS account and region.
  - **Rationale**: The tool must not create local tracking for an instance that is absent, stale, or outside the active execution context.
- **Invalid alias or conflicting local state**: The alias is malformed or already tracked.
  - **Rationale**: Local tracking integrity depends on unique aliases and explicit selection semantics.

### `devbox rm <alias> [--terminate]`

- **Missing alias**: The requested alias is not present in local tracking.
  - **Rationale**: Removal must be explicit and predictable; silently succeeding on an unknown alias would hide operator mistakes.
- **Termination request failure**: `rm --terminate` cannot obtain accepted termination from AWS for a still-existing tracked instance.
  - **Rationale**: The destructive AWS path must be explicit, auditable, and leave local tracking unchanged when AWS refuses the request.
- **Post-termination local divergence**: AWS accepts termination or reports the instance already absent, but local tracking cannot be updated afterward.
  - **Rationale**: Users must know that AWS state changed even if local tracking still retains the alias.

### `devbox switch <alias>`

- **Missing alias prevents selection**: The requested alias does not exist in local tracking.
  - **Rationale**: Current-box selection must remain trustworthy; switching to a non-existent alias would corrupt the user's local model.

### `devbox up`

- **Stale tracked box**: The current alias points to an instance that is missing or no longer describable in the active AWS account or region.
  - **Rationale**: Users need clear feedback when local tracking and current AWS context diverge so they do not assume a start request reached a real target.
- **Invalid starting state**: The instance is already `shutting-down` or `terminated` and cannot be started through the supported transition path.
  - **Rationale**: The tool must not send invalid lifecycle requests that conflict with EC2 state rules.
- **Bounded wait timeout**: The requested transition does not reach `running` within the documented bound.
  - **Rationale**: The utility must never wait indefinitely or imply success before the target state is observed.

### `devbox down`

- **Stale tracked box**: The current alias points to an instance that is missing or no longer describable in the active AWS account or region.
  - **Rationale**: Users need clear feedback when local tracking and current AWS context diverge so they do not assume a stop request reached a real target.
- **Invalid starting state**: The instance is already `shutting-down` or `terminated` and cannot be stopped through the supported transition path.
  - **Rationale**: The tool must not send invalid lifecycle requests that conflict with EC2 state rules.
- **Bounded wait timeout**: The requested transition does not reach `stopped` within the documented bound.
  - **Rationale**: The utility must never wait indefinitely or imply success before the target state is observed.

### `devbox connect`

- **Non-running or stale target**: The current tracked instance is not in `running` state or is no longer describable in the active AWS account and region.
  - **Rationale**: Remote access must target a real, running machine; otherwise users receive misleading connection behavior.
- **SSM readiness timeout**: The instance does not become ready for SSM-backed access within the documented bound.
  - **Rationale**: Session startup must remain bounded and must not appear hung indefinitely.
- **Remote-access setup or cleanup failure**: Temporary SSH access cannot be staged, the session cannot be started, or cleanup cannot be completed as expected.
  - **Rationale**: Remote access is one of the riskiest product surfaces because it crosses local, AWS, and remote-host boundaries.
- **Post-session local divergence**: Session startup succeeds but the `lastConnectAt` update cannot be committed locally.
  - **Rationale**: Users must know the session succeeded even if the local record of that success is stale.

### `devbox cp <local> <remote>`

- **Unsafe or unsupported transfer input**: The local source is not a supported regular file, or the remote destination path violates safety rules.
  - **Rationale**: File transfer crosses both local and remote trust boundaries, so unsafe inputs must be rejected before transport begins.
- **Non-running or stale target**: The current tracked instance is not in `running` state or is no longer describable in the active AWS account and region.
  - **Rationale**: Transfer attempts must not proceed against a missing or unusable target.
- **SSM readiness timeout**: The instance does not become ready for SSM-backed access within the documented bound.
  - **Rationale**: Transfer startup must remain bounded and must not appear hung indefinitely.
- **Transport or remote finalization failure**: Temporary key staging, SSH/SCP transport, or final remote move/cleanup fails.
  - **Rationale**: Upload correctness depends on both the transport path and the final atomic move into place.
- **Post-transfer local divergence**: The remote file update succeeds but the `lastConnectAt` update cannot be committed locally.
  - **Rationale**: Users must know the remote destination may already be updated even if the local metadata is stale.

## Error Format and Exit Codes

### Exit Code Table

| Code | Category | Meaning |
|------|----------|---------|
| 0 | — | Success |
| 2 | ValidationError | Invalid input, alias, template, or remote path |
| 3 | ConfigError | Config malformed, unreadable, or lock conflict |
| 4 | DependencyError | Missing local executable or dependency |
| 5 | AwsCliError | AWS CLI reported API failure |
| 6 | NotFoundError | Instance not describable in active account/region |
| 7 | InstanceStateError | Instance in invalid state for requested transition |
| 8 | TimeoutError | Bounded wait exceeded |
| 9 | ConsistencyError | External success followed by local commit failure |
| 10 | TransportError | SSH, SCP, or key-staging failure |

### Stderr Format

The first line of stderr on failure follows this format:
```
[devbox] <Category>: <concise message>
```

Subsequent lines may contain indented raw stderr from AWS CLI, SSH, or SCP subprocesses when useful for diagnosis.

### Config File Permissions

Config files are created with mode `0644`. The config contains no secrets — only aliases, instance IDs, timestamps, and tag metadata. The advisory lock file uses the same permissions.

### Signal Handling

- During EC2/SSM polling: SIGINT/SIGTERM immediately abort the poll loop and exit. No rollback of already-submitted AWS state transitions.
- During SSH session (`connect`): Signals propagate to the child SSH process via standard Unix process group behavior. Remote temporary key cleanup relies on the bounded background removal job on the remote host.
- During config write: If killed between temp-file write and atomic rename, the temp file is orphaned but committed config remains intact.

### Version Source

The CLI version is read from `package.json` at build time and embedded as a constant. The `--version` flag prints this value. The `defaults.tags.version` field is a separate concern used for instance tagging, not CLI versioning.

## Quality Attributes

- **Reliability**
  - **Target/Threshold**: All documented command postconditions, invariants, and failure contracts are covered by mechanical verification, including property-based tests for stateful behavior.
  - **Influence**: Drives explicit state-machine requirements, atomic config handling, and the distinction between local-tracking truth and AWS truth.
- **Safety**
  - **Target/Threshold**: Destructive operations are opt-in only, unsafe inputs are rejected before transport, and no failed local mutation leaves partial committed config.
  - **Influence**: Shapes command sequencing, input validation, remote-path restrictions, and `rm --terminate` behavior.
- **Security**
  - **Target/Threshold**: Remote access uses short-lived temporary SSH authorization with bounded cleanup, and the product never exposes secrets in normalized error output.
  - **Influence**: Constrains subprocess invocation, logging, SSH-user resolution, and temporary key-staging behavior.
- **Bounded Responsiveness**
  - **Target/Threshold**: EC2 lifecycle waits are bounded to 5 minutes and SSM readiness waits are bounded to 2 minutes.
  - **Influence**: Requires explicit timeout behavior, observable wait-state handling, and non-blocking failure outcomes.
- **Distribution Consistency**
  - **Target/Threshold**: `npm` installation and bundled `dist/devbox.js` execution preserve the same CLI behavior, exit codes, stdout contracts, and stderr contracts.
  - **Influence**: Requires packaging to be treated as part of the product contract, not a secondary implementation concern.
- **Maintainability**
  - **Target/Threshold**: The specification and code map are structured so future changes can localize behavior by capability and architecture layer.
  - **Influence**: Encourages capability-based specs, explicit code maps, and a deterministic domain-core design.

## Capabilities

### New Capabilities
- `box-registry`: Track named boxes in local config, create or register boxes, remove them safely, select the current box, and maintain local config invariants.
- `instance-lifecycle`: Start and stop the current tracked instance with explicit state validation, bounded polling, and stale-resource handling.
- `remote-access`: Connect to or upload files to the current tracked instance through AWS SSM with deterministic SSH-user resolution, temporary key staging, and bounded cleanup.
- `distribution`: Package and distribute the CLI through `npm` and a single-file Node.js artifact while preserving identical user-visible behavior.

### Modified Capabilities
None.
