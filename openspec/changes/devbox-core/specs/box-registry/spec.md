## ADDED Requirements

### Requirement: CLI Registry Commands [BOX-CLI-REGISTRY]
THE devbox CLI SHALL provide local box-registry commands for `list`, `init <alias> <template-file>`, `add <instance-id> <alias>`, `rm <alias> [--terminate]`, and `switch <alias>`.

**References:**
- `proposal.md#Scope`
- `proposal.md#Capabilities`

#### Scenario: List Without Config [BOX-LIST-NOCONFIG]
WHEN the user invokes `devbox` or `devbox list` and the config file is absent, THE devbox CLI SHALL succeed and report an empty tracked-box state.

**Postcondition:** No config file is created and the command reports no tracked boxes.

#### Scenario: Missing Alias Rejected [BOX-REGISTRY-CLI-FAIL]
IF a registry command that requires an existing alias is invoked for an alias not present in local tracking, THEN THE devbox CLI SHALL fail with a normalized error summary and no config mutation.

**Postcondition:** The committed config remains unchanged.

### Requirement: Top Level CLI Flags [BOX-CLI-TOPLEVEL]
THE devbox CLI SHALL support top-level `-v` and `--version` flags that print version information, top-level `-h` and `--help` flags that print command overview and help information together with version information, and no-argument invocation that defaults to `devbox list`.

**References:**
- `proposal.md#Context`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Version Flag Prints Version [BOX-VERSION-FLAG]
WHEN the user invokes `devbox -v` or `devbox --version`, THE devbox CLI SHALL print version information and exit successfully without running `list` or any other command.

**Postcondition:** The process exits after printing version information and no config mutation or AWS interaction occurs.

#### Scenario: Help Flag Prints Help And Version [BOX-HELP-FLAG]
WHEN the user invokes `devbox -h` or `devbox --help`, THE devbox CLI SHALL print command overview and help information together with version information and exit successfully without running `list` or any other command.

**Postcondition:** The process exits after printing help and version information and no config mutation or AWS interaction occurs.

#### Scenario: No Args Default To List [BOX-NOARGS-LIST]
WHEN the user invokes `devbox` with no arguments, THE devbox CLI SHALL behave as `devbox list`.

**Postcondition:** The no-argument invocation follows the documented `list` command contract.

### Requirement: Local Registry State [BOX-DOMAIN-STATE]
THE devbox domain SHALL treat the local config as the source of truth for tracked aliases and current-box selection.

**References:**
- `proposal.md#Domain Model`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Current Alias Preserved [BOX-CURRENT-VALID]
WHILE a config contains a `current` value, THE devbox domain SHALL require that `current` name an existing tracked box.

**Postcondition:** Every committed config either omits `current` or points `current` at an existing alias.

#### Scenario: Invalid Current Alias Rejected [BOX-CURRENT-FAIL]
IF the config contains a `current` alias that does not exist in the tracked box set, THEN THE devbox domain SHALL reject the config as a config failure.

**Postcondition:** No command proceeds using an invalid current alias.

### Requirement: Alias Validation [BOX-DOMAIN-ALIAS]
WHEN the user supplies an alias to a mutating registry command, THE devbox domain SHALL require the alias to match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and be unique within the tracked box registry.

**References:**
- `proposal.md#Domain Model`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Valid Alias Accepted [BOX-ALIAS-ACCEPT]
WHEN the user supplies a unique alias that matches the alias rule, THE devbox domain SHALL allow the command to proceed to its next validation stage.

**Postcondition:** Alias validation does not block the command.

#### Scenario: Duplicate Or Invalid Alias Rejected [BOX-ALIAS-FAIL]
IF the user supplies an alias that violates the alias rule or is already tracked, THEN THE devbox domain SHALL fail before any AWS mutation or local config mutation begins.

**Postcondition:** The command performs no external side effect.

### Requirement: Config Model [BOX-DOMAIN-CONFIG]
THE devbox domain SHALL model config state with required `boxes`, optional `current`, required `defaults.tags`, optional `defaults.ImageId`, optional `defaults.IamInstanceProfile`, optional `defaults.sshUser`, optional per-box `sshUser`, and optional per-box `lastConnectAt`.

**References:**
- `proposal.md#Scope`
- `proposal.md#Domain Model`

#### Scenario: First Run Synthesis [BOX-CONFIG-FIRSTRUN]
WHEN a mutating command runs without an existing config file, THE devbox domain SHALL synthesize first-run state with an empty `boxes` object, no `current`, and required defaults without inventing environment-specific launch values.

**Postcondition:** The initial config model is valid and contains no fabricated AWS-specific values beyond documented defaults.

#### Scenario: Invalid Config Rejected [BOX-CONFIG-FAIL]
IF the existing config does not satisfy the config model, THEN THE devbox domain SHALL fail with a config error before performing any mutation.

**Postcondition:** The prior committed config remains the last trusted state.

### Requirement: SSH User Resolution Inputs [BOX-DOMAIN-SSHUSER]
WHEN remote-access commands require an SSH user, THE devbox domain SHALL resolve the SSH user in this precedence order: invocation override, per-box `sshUser`, then `defaults.sshUser`.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Per Box Override Used [BOX-SSHUSER-BOX]
WHILE a tracked box contains a per-box `sshUser` and the command does not specify an invocation override, THE devbox domain SHALL use the per-box `sshUser` instead of `defaults.sshUser`.

**Postcondition:** The resolved SSH user matches the tracked box override.

#### Scenario: Missing SSH User Rejected [BOX-SSHUSER-FAIL]
IF a remote-access command requires an SSH user and none can be resolved from invocation override, per-box override, or `defaults.sshUser`, THEN THE devbox domain SHALL fail before any remote-access transport begins.

**Postcondition:** No temporary SSH key staging or session startup is attempted.

### Requirement: Instance ID Acceptance [BOX-DOMAIN-INSTANCEID]
WHEN `add <instance-id> <alias>` is invoked, THE devbox domain SHALL treat AWS instance description in the active account and region as authoritative and SHALL warn, not reject, when the supplied instance ID looks malformed against the advisory regex.

**References:**
- `proposal.md#Context`
- `proposal.md#Failure Modes`

#### Scenario: Malformed Looking Instance ID Warned [BOX-INSTANCEID-WARN]
WHEN the supplied instance ID does not match the advisory EC2 instance-ID regex but AWS still accepts it as describable in the active account and region, THE devbox domain SHALL continue the command and emit a warning rather than a validation failure.

**Postcondition:** The box may be added if the instance is describable.

#### Scenario: Undescribable Instance Rejected [BOX-INSTANCEID-FAIL]
IF the supplied instance ID cannot be described in the active account and region, THEN THE devbox domain SHALL fail before adding local tracking.

**Postcondition:** No new alias is committed.

### Requirement: Init Launch Contract [BOX-DOMAIN-INIT]
WHEN `init <alias> <template-file>` succeeds, THE devbox domain SHALL create exactly one tracked box for the returned instance ID, set `current` to the alias, and preserve the documented merge and validation rules for launch input.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Init Success Commits Tracking [BOX-INIT-SUCCESS]
WHEN `init` receives a valid alias, a valid template file, required launch values after merge, and an AWS launch success response containing exactly one instance ID, THE devbox domain SHALL commit `boxes[alias].instanceId` and set `current` to the alias.

**Postcondition:** The new alias is tracked locally and selected as current.

#### Scenario: Init External Success Local Failure [BOX-INIT-CONSISTENCY]
IF `init` successfully launches the AWS instance but the subsequent local config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that AWS state changed while local tracking may be stale.

**Postcondition:** The command reports divergence explicitly instead of downgrading it to a plain config failure.

### Requirement: Add Command Contract [BOX-DOMAIN-ADD]
WHEN `add <instance-id> <alias>` succeeds, THE devbox domain SHALL add the alias to local tracking and set `current` to that alias.

**References:**
- `proposal.md#Scope`
- `proposal.md#Capabilities`

#### Scenario: Add Success Sets Current [BOX-ADD-SUCCESS]
WHEN `add` validates the alias and confirms that the instance is describable in the active account and region, THE devbox domain SHALL commit the alias mapping and set `current` to the alias.

**Postcondition:** The new alias is tracked and selected.

#### Scenario: Add Fails Before Commit [BOX-ADD-FAIL]
IF `add` cannot validate the alias or cannot confirm the instance in the active account and region, THEN THE devbox domain SHALL fail without mutating local tracking.

**Postcondition:** Existing aliases and `current` remain unchanged.

### Requirement: Remove Command Contract [BOX-DOMAIN-RM]
WHEN `rm <alias> [--terminate]` is invoked, THE devbox domain SHALL remove the alias locally, clear `current` if it pointed to that alias, and only request AWS termination when `--terminate` is explicitly supplied.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Failure Modes`

#### Scenario: Local Remove Without Termination [BOX-RM-LOCAL]
WHEN `rm <alias>` is invoked without `--terminate`, THE devbox domain SHALL remove the alias locally even if the tracked instance is stale.

**Postcondition:** The alias no longer exists in local tracking and no AWS termination is attempted.

#### Scenario: Termination Accepted But Local Commit Fails [BOX-RM-CONSISTENCY]
IF `rm --terminate` receives accepted termination or already-absent handling from AWS and the subsequent local config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that local tracking may still retain the alias.

**Postcondition:** The command exposes divergence between AWS state and local tracking.

### Requirement: Switch Command Contract [BOX-DOMAIN-SWITCH]
WHEN `switch <alias>` is invoked for a tracked alias, THE devbox domain SHALL set `current` to that alias without mutating any other tracked box.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Switch Success [BOX-SWITCH-SUCCESS]
WHEN the user invokes `switch` for an existing alias, THE devbox domain SHALL commit `current = alias`.

**Postcondition:** Future current-box commands target the switched alias.

#### Scenario: Switch Missing Alias [BOX-SWITCH-FAIL]
IF the user invokes `switch` for an alias that is not tracked, THEN THE devbox domain SHALL fail without any AWS dependency.

**Postcondition:** The current selection remains unchanged.

### Requirement: Atomic Config Mutation [BOX-ADAPTER-ATOMIC]
WHEN a mutating registry command commits config state, THE devbox adapter SHALL use single-writer advisory locking, temp-file write, `fsync`, atomic replace, and best-effort stale-lock recovery.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Successful Atomic Replace [BOX-ATOMIC-SUCCESS]
WHEN the adapter acquires the advisory lock and completes the write flow successfully, THE devbox adapter SHALL leave a schema-valid committed config and remove the lock file on normal completion.

**Postcondition:** The target config path contains the full next config and no partial JSON.

#### Scenario: Live Lock Rejected [BOX-ATOMIC-FAIL]
IF the advisory lock is held by a live, recent process and is not stale, THEN THE devbox adapter SHALL reject the mutation with a config failure instead of merging concurrent writers.

**Postcondition:** The previously committed config remains unchanged.

### Requirement: List Output Format [BOX-CLI-LIST-FORMAT]
WHEN `devbox list` prints tracked boxes, THE devbox CLI SHALL render a human-readable terminal table with columns: current-box indicator, alias, instance ID, instance type, and state.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Table With Current Indicator [BOX-LIST-TABLE]
WHEN tracked boxes exist and AWS enrichment succeeds, THE devbox CLI SHALL print a table where the current box row is marked with `*` in the first column and other rows show a space.

**Postcondition:** The table includes alias, instance ID, instance type, and one of the state values: `running`, `stopped`, `pending`, `stopping`, `shutting-down`, `terminated`, `stale`, or `unknown`.

#### Scenario: Empty Registry Prints Message [BOX-LIST-EMPTY]
WHEN no boxes are tracked, THE devbox CLI SHALL print the single line `No boxes tracked`.

**Postcondition:** No table header or empty table is rendered.

### Requirement: Config Permissions [BOX-ADAPTER-PERMS]
WHEN the config-store adapter creates config or lock files, THE devbox adapter SHALL create them with mode `0644`.

**References:**
- `proposal.md#Quality Attributes`

#### Scenario: Config Created With Standard Permissions [BOX-PERMS-CONFIG]
WHEN a mutating command creates `~/.config/devbox.json` for the first time, THE devbox adapter SHALL set file mode `0644`.

**Postcondition:** The config file is readable by the owner and group/others.

### Requirement: Stale Lock Specification [BOX-ADAPTER-STALELOCK]
WHEN the advisory lock file exists and the current process needs to acquire it, THE devbox adapter SHALL detect staleness using PID validity, PID liveness, and a 5-minute mtime threshold.

**References:**
- `proposal.md#Quality Attributes`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Stale Lock By Dead PID [BOX-STALELOCK-PID]
WHEN the lock file contains a PID that does not correspond to a running process, THE devbox adapter SHALL treat the lock as stale, remove it, and retry acquisition once.

**Postcondition:** The stale lock does not permanently block the mutation.

#### Scenario: Stale Lock By Age [BOX-STALELOCK-AGE]
WHEN the lock file mtime is older than 5 minutes, THE devbox adapter SHALL treat the lock as stale regardless of PID liveness.

**Postcondition:** Long-orphaned locks are recovered automatically.

#### Scenario: Live Lock Not Stolen [BOX-STALELOCK-LIVE]
WHEN the lock file contains a valid PID of a running process and the mtime is within 5 minutes, THE devbox adapter SHALL reject the mutation with `ConfigError`.

**Postcondition:** A live, recent lock holder is never preempted.

### Requirement: Remove Clears Current [BOX-DOMAIN-RM-CURRENT]
WHEN `rm` removes an alias that is the current box, THE devbox domain SHALL clear `current` by removing it from config entirely rather than reassigning it to another box.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Current Becomes Absent After Remove [BOX-RM-CURRENT-CLEAR]
WHEN `rm <alias>` removes the alias that is also `current`, THE devbox domain SHALL set `current` to absent in the committed config.

**Postcondition:** No automatic reassignment occurs and subsequent current-box commands require explicit `switch`.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
