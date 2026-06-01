# Devbox Revised Plan

## Scope and Goal

Build a small TypeScript CLI, `devbox`, for creating and managing AWS EC2 development machines by shelling out to `aws ec2` and `aws ssm`. The tool remains a thin AWS CLI wrapper, stores local tracking state in a single JSON config file, and avoids the AWS SDK.

This plan places emphasis on:

- documenting preconditions, postconditions, invariants, inputs, outputs, and failure modes for every command
- defining bounded timeout behavior
- specifying atomic write and single-writer behavior
- minimizing dependencies
- explicit safety, security, stale-resource, and verification rules

---

## Requirements Summary

### Commands

- `devbox` or `devbox list`
- `devbox init <alias> <template-file>`
- `devbox add <instance-id> <alias>`
- `devbox rm <alias> [--terminate]`
- `devbox switch <alias>`
- `devbox up`
- `devbox down`
- `devbox connect`
- `devbox cp <local> <remote>`

### Runtime and Tooling

- Node.js 20+
- TypeScript
- `npm` as the primary installation and distribution channel
- `commander` for CLI parsing
- `zod` for config and input validation
- `vitest` for tests
- `fast-check` integrated with `vitest` for property-based testing of stateful behavior and invariants
- `esbuild` for producing an optional single-file Node.js distribution artifact
- built-in `child_process` for subprocess execution

### Dependency Classes

Local-only commands:

- `switch`
- `rm` without `--terminate`

Local-first commands with optional AWS enrichment:

- `list`

AWS-dependent commands:

- `init`
- `add`
- `up`
- `down`
- `connect`
- `cp`
- `rm --terminate`

External executables by capability:

- all AWS-dependent commands require `aws`
- `connect` and `cp` require the AWS Session Manager plugin because they depend on SSM session features
- `cp` additionally requires local `ssh` and `scp`
- `cp` additionally requires the remote instance to run `sshd` on port 22 and provide `sh`, `mv`, and `rm`

### Distribution and Installation

- the primary supported distribution and installation path is via `npm`
- the package must install cleanly through `npm` and expose the `devbox` CLI in the standard Node.js way
- the project must also support compilation to a single JavaScript output file at `dist/devbox.js`
- the generated single-file artifact must begin with the exact shebang `#!/usr/bin/env node`
- the generated single-file artifact must be directly executable as a CLI on POSIX systems
- the generated single-file artifact must run under Node.js 20+ without requiring the TypeScript source tree at runtime
- the single-file artifact is an additional supported distribution format, not the primary installation path
- both the `npm`-installed CLI and the single-file artifact must preserve the same CLI behavior, exit codes, stdout contracts, and stderr contracts

### References

The `connect` and `cp` command follow the same approach described within [ssh-over-ssm](https://github.com/elpy1/ssh-over-ssm).

---

## Configuration Model

Path: `~/.config/devbox.json`

Example configured state:

```json
{
  "current": "workbox",
  "boxes": {
    "workbox": {
      "instanceId": "i-0123456789abcdef0",
      "lastConnectAt": "2026-05-29T12:34:56.000Z"
    }
  },
  "defaults": {
    "ImageId": "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
    "IamInstanceProfile": {
      "Name": "AmazonSSMRoleForInstancesQuickSetup"
    },
    "tags": {
      "env": "dev",
      "service": "devbox",
      "version": "0000000",
      "customer-data": "false",
      "team": "engineering"
    }
  }
}
```

Schema rules:

- `current` is optional
- `boxes` is required and alias-keyed
- `boxes[alias].instanceId` is required
- `boxes[alias].lastConnectAt` is optional
- `defaults.tags` is required
- `defaults.ImageId` is optional
- `defaults.IamInstanceProfile` is optional

### Config Creation Policy

- `list` treats a missing config file as empty state
- mutating commands auto-create `~/.config` if missing
- mutating commands auto-create `~/.config/devbox.json` if missing
- synthesized first-run config contains:
  - `boxes = {}`
  - no `current`
  - `defaults.tags` only
- synthesized first-run config does not invent environment-specific `ImageId` or `IamInstanceProfile`
- `init` fails with `ValidationError` if `ImageId` or `IamInstanceProfile` is absent after merging template and config defaults

### Config Source-of-Truth Rules

- local config is the source of truth for tracked aliases
- AWS is the source of truth for live instance state
- commands that mutate both local state and AWS must declare ordering and partial-failure behavior explicitly

---

## Core Validation Rules

All strings and input are treated as UTF-8 encoded strings.

### Alias Rules

Alias format is intentionally stricter than EC2 `Name` tag rules for CLI ergonomics.

- regex: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`
- length: 1 to 64 characters
- must be unique within `boxes`

### Instance ID Rules

A warning is generated when an Instance ID does not conform to the regex, but is never rejected.
This helps captured typing mistakes, but doesn't break `devbox` if AWS changes the instance ID format.

- regex: `^i-[0-9a-f]{8,17}$`

### Remote Path Rules

Applies to `devbox cp <local> <remote>`.

- remote path must be non-empty after trimming
- remote path must not contain ASCII control characters (bytes `0x00`-`0x1F`, `0x7F`)
- remote path must not contain null bytes
- these restrictions are validated before any transport operation begins
- rejection produces `ValidationError` with a message identifying the offending character class
- this prevents shell injection vectors that are not fully mitigated by POSIX single-quote escaping alone, especially control characters and embedded newlines

### Required Tags

These must be present and non-empty after merge:

- `env` with allowed values `prod | preprod | staging | dev`
- `service` and must equal `devbox`
- `version` as a 7 to 40 character release identifier, with `0000000` allowed as the built-in placeholder default
- `customer-data` with allowed values `true | false`
- `team` as a short identifier

### `UserData` Rule

- template JSON may provide `UserData` in any form accepted by `aws ec2 run-instances --user-data`
- `devbox init` never modifies, interprets, validates, or base64-encodes `UserData`
- `devbox init` passes the `UserData` value through unchanged to `aws ec2 run-instances`
- values such as `file:~/some-file.sh` must be preserved exactly because AWS CLI handles special prefixes and base64 encoding behavior itself

### Tag Merge Policy

`init` must build AWS instance tags using this precedence order:

1. built-in required tag defaults
2. `config.defaults.tags`
3. template `TagSpecifications` for `ResourceType=instance`
4. forced `Name=<alias>` override
5. required-tag validation

Additional tag rules:

- `devbox` always emits exactly one merged `TagSpecification` for `ResourceType=instance`
- template `TagSpecifications` for non-instance resource types pass through unchanged
- if the template also contains an `instance` `TagSpecification`, its tags are merged rather than duplicated
- `Name` from the template is ignored and replaced with the alias

---

## Architecture

Core functionality within the utility is fully deterministic, forcing all sources of non-determinism to the outer layers.
The code favors pure functions and functional programming techniques while still maintaining a common TypeScript style.
All functions clearly document their preconditions, postconditions, and invariants. The code defensively asserts these contracts and checks for all failure modes and edge conditions.

### Layers

1. CLI layer
- parse args and flags
- dispatch commands
- format stdout and stderr
- map errors to fixed exit codes
- provide a build and packaging entrypoint that supports standard `npm` distribution and a bundled single-file Node.js executable script

2. Domain layer
- validate aliases, templates, local files, and command preconditions
- merge defaults and enforce tag policy
- enforce instance-state and stale-resource rules
- build safe AWS CLI argv arrays
- define config mutation and partial-failure rules

3. Adapter layer
- AWS CLI process wrapper via `child_process.spawn`
- SSH and SCP process wrapper via `child_process.spawn`
- config store with lock file, temp file write, and atomic replace
- JSON parsing and stderr normalization

### Proposed Structure

```text
src/
  index.ts
  cli/
    commands/
      list.ts
      init.ts
      add.ts
      rm.ts
      switch.ts
      up.ts
      down.ts
      connect.ts
      cp.ts
  domain/
    config-schema.ts
    alias.ts
    tags.ts
    init-mapper.ts
    instance-state.ts
    ssm-readiness.ts
    wait-policy.ts
    output-contracts.ts
    errors.ts
  adapters/
    aws-cli.ts
    ssh-cli.ts
    config-store.ts
build/
  esbuild.ts
dist/
  devbox.js
test/
```

---

## Atomic Config Write Strategy

All mutating commands use the same local-write algorithm:

1. create `~/.config` if missing
2. acquire an advisory lock file adjacent to the config using exclusive create
3. if the lock already exists, inspect it for staleness before rejecting the mutation
4. read and validate current config, or synthesize first-run config if missing
5. compute the full next config in memory
6. write the full JSON payload to a temp file in the same directory
7. `fsync` the temp file
8. rename the temp file over the target file
9. best-effort `fsync` the containing directory on platforms that support it
10. release the lock file

### Stale Lock Detection

Before rejecting a held advisory lock, the config store performs best-effort staleness detection:

1. read the PID from the lock file
2. if the PID is missing or not a valid integer, treat the lock as stale
3. if the PID does not correspond to a running process, treat the lock as stale
4. if the lock file `mtime` is older than 5 minutes, treat the lock as stale regardless of PID liveness
5. if the lock is determined to be stale, remove it and retry lock acquisition once
6. if the lock is held by a live, recent process, reject the mutation with `ConfigError`

This detection is best-effort and does not upgrade the locking model into distributed or crash-proof consensus. The tool still relies on a single local writer assumption.

### Config Store Preconditions

- mutating commands require write permission to `~/.config`
- mutating commands fail fast only when the advisory lock is held by a live, recent process
- stale locks left by crashed or abandoned processes are recovered automatically

### Config Store Postconditions

- successful mutation leaves a schema-valid JSON file at the target path
- failed mutation leaves the previously committed config unchanged
- lock files are removed on normal completion and best-effort removed on failure
- stale locks from prior crashed invocations do not permanently block future mutations

### Config Store Invariants

- no committed config file contains partial JSON
- the tool assumes a single writer; concurrent mutating invocations are rejected rather than merged
- durability guarantee is atomic replacement under normal process failure, not distributed consensus or multi-host locking
- advisory lock recovery must never remove a lock held by a live, recent process

---

## AWS Process Safety Rules

- subprocesses must be invoked with argv arrays, never shell-interpolated command strings
- when `cp` invokes remote shell commands over SSH, remote paths must be quoted conservatively for POSIX `sh`
- remote paths passed to SSH commands must be validated for control characters before quoting and transmission; quoting alone is not sufficient defense against all injection vectors
- stderr may include AWS CLI details, but secrets and local file contents must not be echoed back in errors
- instance IDs, aliases, account IDs, and regions may be logged because they are operational identifiers, not secrets
- destructive AWS operations must be explicit; `rm` never terminates unless `--terminate` is passed

---

## `init` Design

`devbox init <alias> <template-file>` accepts launch-template-style JSON and maps it into direct `aws ec2 run-instances` arguments. It never creates or modifies AWS launch template resources.

### Required Flow

1. validate alias format and uniqueness
2. read and parse template JSON
3. merge `ImageId` and `IamInstanceProfile` from template over config defaults
4. merge tags using the documented precedence rules
5. pass `UserData`, if present, through unchanged
6. validate the top-level allowlist and conditional conflicts
7. add `MinCount=1` and `MaxCount=1`
8. invoke `aws ec2 run-instances`
9. extract the single returned instance ID
10. persist `boxes[alias].instanceId`
11. set `current = alias`
12. print the instance ID

### Accepted Top-Level Template Fields

- `BlockDeviceMappings`
- `CapacityReservationSpecification`
- `CpuOptions`
- `CreditSpecification`
- `DisableApiStop`
- `DisableApiTermination`
- `EbsOptimized`
- `EnclaveOptions`
- `HibernationOptions`
- `IamInstanceProfile`
- `ImageId`
- `InstanceInitiatedShutdownBehavior`
- `InstanceMarketOptions`
- `InstanceType`
- `KernelId`
- `KeyName`
- `LicenseSpecifications`
- `MaintenanceOptions`
- `MetadataOptions`
- `Monitoring`
- `NetworkInterfaces`
- `Placement`
- `PrivateDnsNameOptions`
- `RamDiskId`
- `SecurityGroupIds`
- `SecurityGroups`
- `TagSpecifications`
- `UserData`

### Added Direct Launch Fields

- `MinCount=1`
- `MaxCount=1`

### Rejected Fields

- `InstanceRequirements`
- any unknown top-level key

### Conditional Rules

If `NetworkInterfaces` is present:

- reject top-level `SecurityGroupIds`
- reject top-level `SecurityGroups`
- require security groups under `NetworkInterfaces[*].Groups`
- reject other interface-scoped conflicts at top level that AWS expects inside the interface object

If `SecurityGroups` is used:

- allow the request to proceed
- surface AWS rejection clearly if the account or network context does not support that request shape

### `init` Inputs

- `alias`: validated local alias and forced EC2 `Name` tag value
- `template-file`: path to JSON file in launch-template-style shape

### `init` Outputs

- stdout on success: single line containing the created instance ID
- stderr on failure: concise reason plus AWS detail when available

---

## Wait and Readiness Policy

### EC2 State Polling

- poll every 5 seconds
- max wait time for `up` and `down`: 5 minutes
- timeout is a command failure
- timeout does not roll back the already-submitted EC2 state transition
- timeout errors include instance ID, expected state, last observed state, and elapsed time

### Transitional State Rules

- `up` accepts `stopped`, `pending`, or `running`
- if the instance is `stopped`, `devbox` sends `start-instances` then waits for `running`
- if the instance is already `pending`, `devbox` does not send another start request and only waits for `running`
- if the instance is `running`, `up` succeeds immediately
- `down` accepts `running`, `stopping`, or `stopped`
- if the instance is `running`, `devbox` sends `stop-instances` then waits for `stopped`
- if the instance is already `stopping`, `devbox` does not send another stop request and only waits for `stopped`
- if the instance is `stopped`, `down` succeeds immediately
- `shutting-down` and `terminated` are invalid for both commands and produce `InstanceStateError`

### SSM Readiness Polling

- `connect` and `cp` require EC2 state `running`
- after EC2 is `running`, poll SSM readiness every 5 seconds for up to 2 minutes
- readiness means the instance is visible to SSM and session startup prerequisites are satisfied
- SSM readiness timeout is a `TimeoutError`

---

## `cp` Transport Design

`cp` uploads one regular local file to one remote path on the current instance.

Transport mechanism:

- use local `scp` for the file transfer, tunneled through SSM using the same general `ProxyCommand` technique as `ssh-over-ssm`
- invoke `scp` and `ssh` with `ProxyCommand=aws ssm start-session --document-name AWS-StartSSHSession --parameters portNumber=%p --target %h`
- use the tracked EC2 instance ID as the SSH host token so the proxy command receives the correct SSM target
- rely on the caller's normal local SSH configuration for username, identity, and host-key policy; `devbox` does not create or manage SSH credentials
- upload to a temp path in the destination directory first
- after `scp` succeeds, invoke `ssh` over the same SSM tunnel to atomically move the temp file into the requested destination path
- perform best-effort remote cleanup of the temp path on failure

Intentional scope limits:

- upload only, not download
- regular files only, not directories, symlinks, or device files
- remote instance must have the [SSM agent](https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-manual-agent-install.html) installed
- local environment must make `ssh` and `scp` work for a host named by the EC2 instance ID when the SSM proxy is injected
- remote shell environment must provide POSIX `sh`, `mv`, and `rm`

Remote write-safety rules:

- upload to a temp path in the destination directory first
- only move into the final destination after successful upload
- failed transfers must not leave a partially written destination file at the requested path
- failed transfers may leave only the temp path behind if cleanup also fails

---

## Stale-Resource Policy

A tracked alias is stale when the stored `instanceId` no longer exists in the active AWS account and region or is no longer describable.

Rules:

- `list` must continue and display stale entries as `stale`
- `up`, `down`, `connect`, and `cp` fail with `NotFoundError` for stale entries
- `rm` without `--terminate` always removes the local alias, even if the instance is stale
- `rm --terminate` treats AWS `InvalidInstanceID.NotFound` as already absent and still removes the local alias
- `add` rejects instance IDs that cannot be described in the active account and region

---

## CLI Output Contract

Successful stdout contracts:

- `list`: human-readable table, or the single line `No boxes tracked`
- `init`: single line `<instance-id>`
- `add`: single line `<instance-id>`
- `rm`: single line `<alias>`
- `switch`: single line `<alias>`
- `up`: single line `<instance-id>`
- `down`: single line `<instance-id>`
- `connect`: no stable stdout contract beyond the proxied interactive session stream
- `cp`: single line `<alias> <remote-path>`

Failure stderr contracts:

- first line is a normalized error summary
- subsequent lines may include preserved AWS CLI stderr when helpful

---

## Command Contracts

## `devbox` / `devbox list`

**Inputs**
- none

**Preconditions**
- config may be missing
- no AWS dependency is required to list local aliases

**Postconditions**
- prints tracked aliases from local config
- if AWS is available, enriches rows with instance type and live EC2 state using batched `describe-instances` calls rather than one call per alias
- if AWS is unavailable, still prints aliases with state shown as `unknown`
- marks at most one current alias
- does not mutate config

**Failure modes**
- invalid config produces `ConfigError`
- AWS enrichment failures do not fail the whole command unless explicit strict mode is added later

**Invariants**
- only aliases from local config are listed
- missing config is treated as empty state

**AWS enrichment strategy**
- `list` collects all tracked instance IDs and issues a single `aws ec2 describe-instances` call for the full set when possible
- if the tracked set exceeds AWS CLI per-call limits, `list` splits the request into bounded batches
- instances returned by AWS are enriched with live state and instance type
- tracked instance IDs omitted from an otherwise successful AWS response are shown as `stale`
- if a full enrichment batch fails because AWS is unavailable, credentials are missing, or the local `aws` executable is absent, `list` still succeeds and shows all rows as `unknown`
- the enrichment algorithm minimizes API calls and reduces the chance of throttling relative to one-call-per-alias behavior

## `devbox init <alias> <template-file>`

**Inputs**
- `alias`
- `template-file`

**Preconditions**
- alias passes validation and is unique
- template file exists, is readable, and contains valid JSON
- template passes direct `run-instances` compatibility validation
- `ImageId` exists after template-over-default merge
- `IamInstanceProfile` exists after template-over-default merge
- required tags are present and non-empty after tag merge
- `aws ec2 run-instances` is permitted by caller IAM

**Postconditions**
- exactly one instance is launched on success
- `boxes[alias].instanceId` is written
- `current` is set to `alias`
- stdout contains the instance ID
- config is unchanged on failure

**Failure modes**
- validation failure prevents any AWS call
- AWS launch failure prevents any config mutation
- config write failure after successful launch leaves the instance running in AWS and reports the divergence clearly to stderr

**Invariants**
- no AWS launch template resources are created
- alias always overrides the instance `Name` tag
- required tags are present and non-empty on success
- committed config remains schema-valid JSON

## `devbox add <instance-id> <alias>`

**Inputs**
- `instance-id`
- `alias`

**Preconditions**
- alias passes validation and is unique
- instance ID format is valid
- instance exists in the active AWS account and region

**Postconditions**
- `boxes[alias]` is added
- `current` is set to `alias`
- stdout contains the instance ID
- config is unchanged on failure

**Failure modes**
- stale or wrong-region instance IDs fail before config mutation

**Invariants**
- alias uniqueness is preserved
- existing tracked boxes are not mutated except for `current` being switched

## `devbox rm <alias> [--terminate]`

**Inputs**
- `alias`
- optional `--terminate`

**Preconditions**
- alias exists in config
- if `--terminate` is given, caller has IAM permission to terminate the tracked instance

**Postconditions**
- without `--terminate`, the alias is removed locally and `current` is cleared if it pointed to that alias. A warning is printed that the AWS resources may still exist.
- with `--terminate`, the instance is terminated first and the alias is removed locally only after AWS confirms termination request acceptance or reports the instance as already absent
- stdout contains the removed alias

**Failure modes**
- without `--terminate`, only local config errors can fail the command
- with `--terminate`, non-NotFound AWS failures leave local config unchanged
- with `--terminate`, config write failure after accepted termination reports divergence clearly because AWS state may have changed while local tracking still exists

**Invariants**
- removing a box never mutates other aliases
- `current` never points to a removed alias
- termination is never implicit

## `devbox switch <alias>`

**Inputs**
- `alias`

**Preconditions**
- alias exists in config

**Postconditions**
- sets `current = alias`
- stdout contains the alias

**Failure modes**
- missing alias fails without any AWS dependency

**Invariants**
- `current` always references an existing alias

## `devbox up`

**Inputs**
- none

**Preconditions**
- `current` is set
- `current` resolves to a tracked instance ID
- instance is not `shutting-down` or `terminated`

**Postconditions**
- if state is `stopped`, sends a start request and waits until `running` or timeout
- if state is `pending`, waits until `running` or timeout without sending another start request
- if state is `running`, succeeds without changing state
- stdout contains the instance ID on success
- config is not otherwise mutated

**Failure modes**
- stale instance ID yields `NotFoundError`
- timeout yields `TimeoutError`
- invalid starting state yields `InstanceStateError`

**Invariants**
- only the current instance is targeted
- only a valid start transition is initiated
- timeout does not corrupt config

## `devbox down`

**Inputs**
- none

**Preconditions**
- `current` is set
- `current` resolves to a tracked instance ID
- instance is not `shutting-down` or `terminated`

**Postconditions**
- if state is `running`, sends a stop request and waits until `stopped` or timeout
- if state is `stopping`, waits until `stopped` or timeout without sending another stop request
- if state is `stopped`, succeeds without changing state
- stdout contains the instance ID on success
- config is not otherwise mutated

**Failure modes**
- stale instance ID yields `NotFoundError`
- timeout yields `TimeoutError`
- invalid starting state yields `InstanceStateError`

**Invariants**
- only the current instance is targeted
- only a valid stop transition is initiated
- timeout does not corrupt config

## `devbox connect`

**Inputs**
- none

**Preconditions**
- `current` is set
- `current` resolves to a tracked instance ID
- instance is in EC2 state `running`
- SSM session prerequisites are installed locally
- instance becomes SSM-ready within the readiness timeout
- local `ssh` executables are installed

**Postconditions**
- starts an SSM session to the current instance, by performing all operations described within [ssh-ssm.sh](https://raw.githubusercontent.com/elpy1/ssh-over-ssm/refs/heads/master/ssh-ssm.sh)
- updates `lastConnectAt` only if session startup succeeds
- does not mutate `current` or `instanceId`

**Failure modes**
- stale instance ID yields `NotFoundError`
- non-running instance yields `InstanceStateError`
- SSM readiness timeout yields `TimeoutError`
- SSM session startup failure does not update `lastConnectAt`

**Invariants**
- only the current instance is targeted
- failed connection attempts do not update `lastConnectAt`

## `devbox cp <local> <remote>`

**Inputs**
- `local`
- `remote`

**Preconditions**
- `current` is set
- `current` resolves to a tracked instance ID
- instance is in EC2 state `running`
- instance becomes SSM-ready within the readiness timeout
- local source exists, is readable, is a regular file
- local `ssh` and `scp` executables are installed
- local SSH configuration and credentials can authenticate to the target instance through the SSM tunnel
- remote path is non-empty and absolute or shell-resolvable by the remote POSIX shell
- remote path contains no ASCII control characters or null bytes
- destination parent directory is writable by the SSH user used for transfer

**Postconditions**
- the file content is written to the requested remote path on success
- destination replacement is atomic from the caller perspective because a temp path is used first and moved into place only after upload succeeds
- `lastConnectAt` is updated only after successful transfer completion
- local source is never modified
- stdout contains `<alias> <remote-path>`

**Failure modes**
- stale instance ID yields `NotFoundError`
- non-running instance yields `InstanceStateError`
- SSM readiness timeout yields `TimeoutError`
- unsupported source type or oversized file yields `ValidationError`
- missing local `ssh` or `scp`, SSH authentication failure, SSH host-key failure, or `scp` process failure yields `TransportError`
- remote command failure does not leave a partial file at the final destination path

**Invariants**
- only the current instance is targeted
- failed transfer does not mutate the local source
- failed transfer does not partially rewrite committed config

---

## Global Preconditions

Applies to all commands:

- process can read the user home directory
- config, if present, must be valid JSON matching the schema

Applies to mutating local commands:

- `~/.config` is creatable or writable

Applies only to AWS-dependent commands:

- `aws` CLI executable is installed
- AWS credentials and region are available to the process
- caller has IAM permissions for the requested EC2 or SSM operations

## Global Postconditions

- successful local mutations leave a schema-valid config at `~/.config/devbox.json`
- failed local mutations do not corrupt the last committed config
- stdout and stderr follow the documented command contracts
- local and AWS divergence is reported explicitly when it cannot be prevented
- the project supports standard installation via `npm`
- the project can also be built into a single executable JavaScript file with the required Node shebang

## Global Invariants

- config path is fixed at `~/.config/devbox.json`
- `boxes` is an alias-keyed object
- alias keys are unique
- `current` is absent or references an existing alias
- every stored `instanceId` matches EC2 instance ID format
- CLI remains a thin wrapper around AWS CLI, SSM, and local OpenSSH tools, not the AWS SDK
- `npm` installation remains a first-class supported distribution path
- the optional distributable single-file CLI artifact begins with `#!/usr/bin/env node`

---

## Error Model

### Categories

- `ValidationError`
- `ConfigError`
- `DependencyError`
- `AwsCliError`
- `TransportError`
- `NotFoundError`
- `InstanceStateError`
- `TimeoutError`
- `ConsistencyError`

### Exit Codes

- `0`: success
- `2`: validation failure
- `3`: config failure
- `4`: missing executable or local dependency failure
- `5`: AWS CLI reported API failure
- `6`: resource not found
- `7`: invalid instance state
- `8`: timeout
- `9`: local and AWS state diverged after partial external success
- `10`: SSH/SCP transport failure

### Rules

- stderr first line contains a concise normalized reason
- include alias and instance ID when relevant
- include expected and actual state for state failures
- preserve AWS CLI stderr details when useful after the normalized summary
- preserve SSH and SCP stderr details when useful after the normalized summary

---

## Security and Safety Considerations

- never interpolate user-controlled values into shell command strings
- treat template JSON and local file paths as untrusted input and validate before use
- never print AWS credentials, session tokens, or raw `UserData` contents
- `rm --terminate` is the only destructive AWS action and must remain opt-in
- `cp` writes through a temp file to avoid partial replacement of an existing remote file
- `connect` and `cp` manage a temporary SSH key swap, described in [ssh-ssm.sh](https://raw.githubusercontent.com/elpy1/ssh-over-ssm/refs/heads/master/ssh-ssm.sh)
- `list` is non-destructive and must not fail solely because AWS enrichment is unavailable
- stale-resource conditions must be surfaced clearly rather than silently repaired

---

## Validation and Verification Plan

All preconditions, postconditions, and invariants must be covered by the tests (at least exercised by unit tests).
Global invariants must be exercised by property-based tests.
Every contract must be exercised by the test suite.
Every state transition must be exercised by the test suite.
Safety and liveness properties must be exercised by property-based tests.

Property-based testing strategy:

- integrate `fast-check` with `vitest` using the documented `fast-check` Vitest environment setup so property tests run in the standard test suite
- model every command family with meaningful stateful behavior as a property-tested state machine, including config-store mutation flows, alias/current selection, EC2 lifecycle handling, SSM readiness gating, and `cp` transfer/finalization sequencing
- generate valid and invalid command/event sequences to exercise all permitted state transitions and representative rejected transitions
- check global invariants after every generated step, not only at the end of a scenario
- encode safety properties as invariants that must always hold
- encode liveness properties as bounded eventuality properties over polling and retry loops, using generated event traces and mocked time/AWS responses
- keep deterministic example-based tests for specific regressions, CLI contracts, and error-shape assertions; property tests complement rather than replace them

Unit and contract tests:

1. config schema validation and first-run auto-create behavior
2. advisory lock acquisition and concurrent mutation rejection
3. temp-file write and atomic replace behavior
4. alias validation and uniqueness enforcement
5. `current` validity rules
6. tag merge precedence and forced `Name` override
7. `ImageId` and `IamInstanceProfile` resolution from template versus config defaults
8. `init` allowlist and reject list
9. `NetworkInterfaces` conflict validation
10. `UserData` pass-through without transformation, including `file:` values
11. `init` sets `current` on success
12. `add` sets `current` only when absent
13. `rm` local-only behavior
14. `rm --terminate` sequencing and partial-failure reporting
15. `up` wait-loop success, pending-state wait, and timeout behavior
16. `down` wait-loop success, stopping-state wait, and timeout behavior
17. `connect` rejects non-running or non-SSM-ready instances
18. `cp` rejects non-regular files, oversized files, non-running instances, and missing SSH prerequisites
19. `cp` `scp`/`ssh` argv construction for SSM proxying, remote temp-file cleanup, and final-path safety guarantees
20. stdout, stderr, and exit-code contract tests for every command
21. package metadata and build configuration support standard `npm` installation of the CLI
22. optional single-file build output is exactly one JavaScript file and begins with the required shebang
23. the `npm`-installed CLI and built single-file artifact preserve the same documented CLI contracts

Property-based state-machine tests:

1. config-store state machine: missing config, synthesized first-run config, lock acquisition, successful mutation, rejected concurrent mutation, and crash-safe atomic replace sequences
2. alias-tracking state machine: generated `init`, `add`, `switch`, and `rm` command sequences preserve alias uniqueness and `current` validity across all transitions
3. EC2 lifecycle state machines for `up` and `down`: generated live-state traces exercise all accepted transitions, all rejected transitions, idempotent success cases, timeout paths, and stale-resource failures
4. SSM readiness state machine for `connect` and `cp`: generated readiness traces verify bounded waiting, success only after readiness, and no premature success
5. `cp` transfer/finalization state machine: generated transport outcomes verify temp-path upload, atomic finalization, cleanup behavior, and no partial final destination writes on failure
6. generated mixed command sequences preserve global config invariants and documented command postconditions after every successful step

Global invariant and property checks:

1. `boxes` remains alias-keyed with unique keys
2. `current` is absent or references an existing alias
3. every committed config is schema-valid JSON
4. no failed local mutation produces partial JSON or partially committed config state
5. no command mutates aliases other than the targeted alias except where `current` is explicitly documented to change
6. destructive AWS effects never occur without an explicit command path that permits them
7. `rm --terminate` never removes local tracking before AWS termination acceptance or accepted already-absent handling
8. `connect` and `cp` never update `lastConnectAt` on failed session or transfer startup
9. `cp` never leaves a partially written file at the final remote destination path
10. time-bounded wait loops never report success before the required target state is observed

Safety and liveness properties:

1. safety: config writes are atomic, schema-valid, and single-writer
2. safety: alias uniqueness and `current` reference integrity are preserved across all reachable local states
3. safety: invalid EC2 starting states never trigger start or stop requests
4. safety: failed `cp` finalization never overwrites the destination with partial content
5. liveness: if generated AWS state traces eventually reach `running`, `up` eventually succeeds within the configured timeout bound
6. liveness: if generated AWS state traces eventually reach `stopped`, `down` eventually succeeds within the configured timeout bound
7. liveness: if generated SSM traces eventually become ready before timeout, `connect` and `cp` eventually proceed; otherwise they fail with `TimeoutError`
8. liveness: if AWS termination is accepted or the instance is already absent, `rm --terminate` eventually removes the local alias unless a local config write failure is injected, in which case it reports divergence explicitly

Adapter and subprocess tests:

1. AWS CLI stdout parsing for success payloads
2. AWS CLI stderr normalization for common EC2 and SSM failures
3. SSH/SCP stderr normalization for common auth, host-key, and remote-command failures
4. `InvalidInstanceID.NotFound` handling for stale resources
5. timeout handling when subprocesses hang or return incomplete data

Integration-oriented tests with mocked AWS CLI fixtures:

1. `init` happy path with config commit
2. `init` AWS success plus config write failure resulting in `ConsistencyError`
3. `up` and `down` polling across multiple state observations
4. `connect` startup success and `lastConnectAt` update
5. `cp` upload-via-`scp` over SSM and remote finalization flow
6. smoke test the `npm`-installed CLI for help output and basic local-only command execution
7. smoke test the bundled `dist/devbox.js` artifact for help output and basic local-only command execution

---

## Implementation Sequence

1. scaffold the TypeScript CLI entrypoint and command router
2. implement config schema, first-run synthesis, advisory locking, and atomic store
3. implement AWS CLI adapter with fixed exit-code mapping and stderr normalization
4. implement alias, tag, and instance-state validators
5. implement `list`, `switch`, and local-only `rm`
6. implement `add`
7. implement `up` and `down` with bounded EC2 polling
8. implement `init` mapper, merge logic, and launch flow
9. implement SSM readiness checks and `connect`
10. implement `cp` using `scp` and `ssh` over SSM with temp-path finalization
11. implement `rm --terminate` with documented sequencing
12. add packaging for standard `npm` installation of the CLI
13. add the optional single-file build pipeline and shebang-preserving distribution artifact
14. verify the `npm`-installed CLI and bundled artifact behave the same as the TypeScript entrypoint
15. integrate `fast-check` with `vitest` and add property-based state-machine coverage for transitions, invariants, and safety/liveness properties
16. add contract, subprocess-fixture, and failure-atomicity tests
17. polish error messages and help text
