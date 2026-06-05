---
title: BoxRegistry
---

## Purpose

Define the local box-registry behavior for `devbox`: tracking named EC2 development machines, selecting the current box, listing tracked boxes, and handling `init`, `add`, `rm`, and `switch` with local config as the durable source of truth.
This spec also captures the registry-side invariants and safety rules, including alias integrity, first-run config synthesis, atomic single-writer config updates, explicit destructive behavior, and the separation between local tracking state and live AWS state.

```alloy
module BoxRegistry

// --- Signatures: Registry domain vocabulary ---

sig Alias {}
sig InstanceId {}

// SSH user sources at different precedence levels
sig SshUser {}

// Config model: the durable local state
// Issue 23 fix: added hasLastConnectAt per BOX-DOMAIN-CONFIG requirement
one sig Config {
  var boxes : Alias -> lone InstanceId,      // tracked alias -> instance mapping
  var current : lone Alias,                  // optional current selection
  var defaultSshUser : lone SshUser,         // defaults.sshUser
  var boxSshUser : Alias -> lone SshUser,    // per-box sshUser override
  var hasLastConnectAt : set Alias           // aliases that have a lastConnectAt timestamp
}

// Lock state for atomic config mutation
// Issue 17: Commands atomically acquire and release the lock in a single transition.
// External processes may hold the lock (modeled via external_lock_acquired), which
// blocks our commands until recovery or release.
abstract sig LockState {}
one sig Free, Held, StaleByPid, StaleByAge extends LockState {}

one sig LockModel {
  var lockState : one LockState,
  var lockHolderAlive : one Bool
}

abstract sig Bool {}
one sig True, False extends Bool {}

// AWS describability of an instance
sig AwsContext {
  describable : set InstanceId
}
one sig ActiveContext extends AwsContext {}

// Command outcomes
abstract sig Outcome {}
one sig CmdSuccess, ValidationError, ConfigError, ConsistencyError, NotFoundError extends Outcome {}

one sig CommandState {
  var lastOutcome : lone Outcome,
  var awsMutated : one Bool,     // tracks whether AWS was changed (for consistency detection)
  var configMutated : one Bool   // tracks whether local config commit succeeded
}
```

## Requirements

### Requirement: CLI Registry Commands [BOX-CLI-REGISTRY]
THE devbox CLI SHALL provide local box-registry commands for `list`, `init <alias> <template-file>`, `add <instance-id> <alias>`, `rm <alias> [--terminate]`, and `switch <alias>`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Capabilities`

#### Scenario: List Without Config [BOX-LIST-NOCONFIG]
WHEN the user invokes `devbox` or `devbox list` and the config file is absent, THE devbox CLI SHALL succeed and report an empty tracked-box state.

**Postcondition:** No config file is created and the command reports no tracked boxes.

#### Scenario: Missing Alias Rejected [BOX-REGISTRY-CLI-FAIL]
IF a registry command that requires an existing alias is invoked for an alias not present in local tracking, THEN THE devbox CLI SHALL fail with a normalized error summary and no config mutation.

**Postcondition:** The committed config remains unchanged.

```alloy
// --- List and missing-alias rejection ---

pred list_no_config {
  // Guard: no config file (empty boxes represents absent config)
  no Config.boxes
  // Effect: success, no mutation
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
  // Frame
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

pred missing_alias_rejected [a : Alias] {
  // Guard: alias not tracked
  a not in Config.boxes.InstanceId
  // Effect: fail, no mutation
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = NotFoundError
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
  // Frame
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Issue 6 fix: scoped to the event predicate rather than all untracked aliases globally
assert missing_alias_no_mutation {
  always (all a : Alias |
    missing_alias_rejected[a] implies Config.boxes' = Config.boxes)
}
```

### Requirement: Top Level CLI Flags [BOX-CLI-TOPLEVEL]
THE devbox CLI SHALL support top-level `-v` and `--version` flags that print version information, top-level `-h` and `--help` flags that print command overview and help information together with version information, and no-argument invocation that defaults to `devbox list`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Context`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Version Flag Prints Version [BOX-VERSION-FLAG]
WHEN the user invokes `devbox -v` or `devbox --version`, THE devbox CLI SHALL print version information and exit successfully without running `list` or any other command.

**Postcondition:** The process exits after printing version information and no config mutation or AWS interaction occurs.

#### Scenario: Help Flag Prints Help And Version [BOX-HELP-FLAG]
WHEN the user invokes `devbox -h` or `devbox --help`, THE devbox CLI SHALL print command overview and help information together with version information and exit successfully without running `list` or any other command.

**Postcondition:** The process exits after printing help and version information and no config mutation or AWS interaction occurs.

#### Scenario: No Args Default To List [BOX-NOARGS-LIST]
WHEN the user invokes `devbox` with no arguments, THE devbox CLI SHALL behave as `devbox list`.

**Postcondition:** The no-argument invocation follows the documented `list` command contract.

```alloy
// --- Informational commands: pure output, no side effects ---

pred informational_command {
  // Effect: no config mutation, no AWS interaction
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Safety: informational commands never mutate state
assert informational_no_side_effects {
  always (informational_command implies (
    Config.boxes' = Config.boxes and
    Config.current' = Config.current and
    CommandState.awsMutated' = False))
}
```

### Requirement: Local Registry State [BOX-DOMAIN-STATE]
THE devbox domain SHALL treat the local config as the source of truth for tracked aliases and current-box selection.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Current Alias Preserved [BOX-CURRENT-VALID]
WHILE a config contains a `current` value, THE devbox domain SHALL require that `current` name an existing tracked box.

**Postcondition:** Every committed config either omits `current` or points `current` at an existing alias.

#### Scenario: Invalid Current Alias Rejected [BOX-CURRENT-FAIL]
IF the config contains a `current` alias that does not exist in the tracked box set, THEN THE devbox domain SHALL reject the config as a config failure.

**Postcondition:** No command proceeds using an invalid current alias.

```alloy
// --- Core invariant: current always references an existing tracked alias ---

// This is the fundamental registry integrity invariant.
// It must hold in every reachable state after init.
pred current_integrity {
  some Config.current implies Config.current in Config.boxes.InstanceId
}

// Safety: current integrity is preserved across all transitions
assert current_always_valid {
  always current_integrity
}
```

### Requirement: Alias Validation [BOX-DOMAIN-ALIAS]
WHEN the user supplies an alias to a mutating registry command, THE devbox domain SHALL require the alias to match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and be unique within the tracked box registry.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Valid Alias Accepted [BOX-ALIAS-ACCEPT]
WHEN the user supplies a unique alias that matches the alias rule, THE devbox domain SHALL allow the command to proceed to its next validation stage.

**Postcondition:** Alias validation does not block the command.

#### Scenario: Duplicate Or Invalid Alias Rejected [BOX-ALIAS-FAIL]
IF the user supplies an alias that violates the alias rule or is already tracked, THEN THE devbox domain SHALL fail before any AWS mutation or local config mutation begins.

**Postcondition:** The command performs no external side effect.

```alloy
// --- Alias validation: uniqueness within registry ---
// Note: Regex syntax validation is a domain rule not expressible in Alloy's
// relational logic; we model the abstract property that aliases are valid tokens.
// Uniqueness IS expressible and is modeled here.

pred alias_available [a : Alias] {
  a not in Config.boxes.InstanceId
}

pred alias_tracked [a : Alias] {
  a in Config.boxes.InstanceId
}

// Precondition for mutating commands that add aliases
pred alias_valid_for_add [a : Alias] {
  alias_available[a]
}

// Safety: duplicate alias is never committed
assert no_duplicate_alias {
  always (all a : Alias |
    // boxes is functional: each alias maps to at most one InstanceId
    lone Config.boxes[a])
}

// Issue 7 fix: scoped to the add_fails event rather than all tracked aliases
assert alias_reject_no_side_effect {
  always (all a : Alias, iid : InstanceId |
    add_fails[a, iid] implies (
      CommandState.awsMutated' = False and
      Config.boxes' = Config.boxes))
}
```

### Requirement: Config Model [BOX-DOMAIN-CONFIG]
THE devbox domain SHALL model config state with required `boxes`, optional `current`, required `defaults.tags`, optional `defaults.ImageId`, optional `defaults.IamInstanceProfile`, optional `defaults.sshUser`, optional per-box `sshUser`, and optional per-box `lastConnectAt`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Domain Model`

#### Scenario: First Run Synthesis [BOX-CONFIG-FIRSTRUN]
WHEN a mutating command runs without an existing config file, THE devbox domain SHALL synthesize first-run state with an empty `boxes` object, no `current`, and required defaults without inventing environment-specific launch values.

**Postcondition:** The initial config model is valid and contains no fabricated AWS-specific values beyond documented defaults.

#### Scenario: Invalid Config Rejected [BOX-CONFIG-FAIL]
IF the existing config does not satisfy the config model, THEN THE devbox domain SHALL fail with a config error before performing any mutation.

**Postcondition:** The prior committed config remains the last trusted state.

```alloy
// --- Config model: well-formedness predicate ---

pred config_wellformed {
  // current, if present, must reference a tracked alias
  current_integrity
  // boxes is a partial function: each alias has at most one instanceId
  all a : Alias | lone Config.boxes[a]
  // boxSshUser only defined for tracked aliases
  Config.boxSshUser.SshUser in Config.boxes.InstanceId
  // lastConnectAt only defined for tracked aliases
  Config.hasLastConnectAt in Config.boxes.InstanceId
}

// First-run synthesis produces a well-formed empty config
pred first_run_synthesis {
  no Config.boxes
  no Config.current
  no Config.boxSshUser
  no Config.hasLastConnectAt
  // defaultSshUser may or may not be present (it's optional)
}

// Safety: first-run config is always well-formed
assert first_run_valid {
  first_run_synthesis implies config_wellformed
}

// Safety: invalid config blocks all mutations
assert invalid_config_blocks_mutation {
  always (not config_wellformed implies (
    Config.boxes' = Config.boxes and
    Config.current' = Config.current))
}
```

### Requirement: SSH User Resolution Inputs [BOX-DOMAIN-SSHUSER]
WHEN remote-access commands require an SSH user, THE devbox domain SHALL resolve the SSH user in this precedence order: invocation override, per-box `sshUser`, then `defaults.sshUser`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Per Box Override Used [BOX-SSHUSER-BOX]
WHILE a tracked box contains a per-box `sshUser` and the command does not specify an invocation override, THE devbox domain SHALL use the per-box `sshUser` instead of `defaults.sshUser`.

**Postcondition:** The resolved SSH user matches the tracked box override.

#### Scenario: Missing SSH User Rejected [BOX-SSHUSER-FAIL]
IF a remote-access command requires an SSH user and none can be resolved from invocation override, per-box override, or `defaults.sshUser`, THEN THE devbox domain SHALL fail before any remote-access transport begins.

**Postcondition:** No temporary SSH key staging or session startup is attempted.

```alloy
// --- SSH user resolution: precedence model ---

// Resolution function: invocation > per-box > defaults
fun resolve_ssh_user [invocationOverride : lone SshUser, box : Alias] : lone SshUser {
  // Highest precedence: invocation override
  (some invocationOverride) implies invocationOverride
  // Middle: per-box override
  else (some Config.boxSshUser[box]) implies Config.boxSshUser[box]
  // Lowest: defaults
  else Config.defaultSshUser
}

// Predicate: SSH user is resolvable for a given box
pred ssh_user_resolvable [invocationOverride : lone SshUser, box : Alias] {
  some resolve_ssh_user[invocationOverride, box]
}

// Safety: remote access never proceeds without a resolved SSH user
assert no_remote_access_without_ssh_user {
  always (all a : Config.current |
    not ssh_user_resolvable[none, a] implies
      CommandState.lastOutcome' != CmdSuccess)
}
```

### Requirement: Instance ID Acceptance [BOX-DOMAIN-INSTANCEID]
WHEN `add <instance-id> <alias>` is invoked, THE devbox domain SHALL treat AWS instance description in the active account and region as authoritative and SHALL warn, not reject, when the supplied instance ID looks malformed against the advisory regex.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Context`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Malformed Looking Instance ID Warned [BOX-INSTANCEID-WARN]
WHEN the supplied instance ID does not match the advisory EC2 instance-ID regex but AWS still accepts it as describable in the active account and region, THE devbox domain SHALL continue the command and emit a warning rather than a validation failure.

**Postcondition:** The box may be added if the instance is describable.

#### Scenario: Undescribable Instance Rejected [BOX-INSTANCEID-FAIL]
IF the supplied instance ID cannot be described in the active account and region, THEN THE devbox domain SHALL fail before adding local tracking.

**Postcondition:** No new alias is committed.

```alloy
// --- Instance ID acceptance: AWS describability is authoritative ---

pred instance_describable [iid : InstanceId] {
  iid in ActiveContext.describable
}

pred instance_not_describable [iid : InstanceId] {
  iid not in ActiveContext.describable
}

// Safety: undescribable instance never committed to tracking
assert undescribable_never_tracked {
  always (all a : Alias, iid : InstanceId |
    (instance_not_describable[iid]) implies
      iid not in Config.boxes'[a] - Config.boxes[a])
}
```

### Requirement: Init Launch Contract [BOX-DOMAIN-INIT]
WHEN `init <alias> <template-file>` succeeds, THE devbox domain SHALL create exactly one tracked box for the returned instance ID, set `current` to the alias, and preserve the documented merge and validation rules for launch input.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Init Success Commits Tracking [BOX-INIT-SUCCESS]
WHEN `init` receives a valid alias, a valid template file, required launch values after merge, and an AWS launch success response containing exactly one instance ID, THE devbox domain SHALL commit `boxes[alias].instanceId` and set `current` to the alias.

**Postcondition:** The new alias is tracked locally and selected as current.

#### Scenario: Init External Success Local Failure [BOX-INIT-CONSISTENCY]
IF `init` successfully launches the AWS instance but the subsequent local config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that AWS state changed while local tracking may be stale.

**Postcondition:** The command reports divergence explicitly instead of downgrading it to a plain config failure.

```alloy
// --- Init command: launch + track ---
// Issue 20 fix: Template parameter connects template validation to init events

pred init_success [a : Alias, iid : InstanceId, t : Template] {
  // Preconditions
  alias_available[a]
  instance_describable[iid]   // launched instance must be visible to AWS
  config_wellformed
  LockModel.lockState = Free
  template_valid[t]
  init_required_values_present[t]
  // AWS launches successfully, returns exactly one instance ID
  // Effect: add to boxes, set current
  Config.boxes' = Config.boxes + (a -> iid)
  Config.current' = a
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = True
  CommandState.configMutated' = True
  // Lock released (atomic acquire-mutate-release in one transition)
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

pred init_consistency_error [a : Alias, iid : InstanceId, t : Template] {
  // Preconditions: same as success
  alias_available[a]
  config_wellformed
  LockModel.lockState = Free
  template_valid[t]
  init_required_values_present[t]
  // AWS launches successfully (external success)
  CommandState.awsMutated' = True
  // But local config commit FAILS
  CommandState.configMutated' = False
  Config.boxes' = Config.boxes      // config unchanged
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = ConsistencyError
  // Lock released
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Issue 20 fix: template validation failure event (connected to transitions)
pred init_template_rejected [a : Alias, t : Template] {
  alias_available[a]
  config_wellformed
  LockModel.lockState = Free
  // Guard: template is invalid or missing required values
  (template_invalid[t] or init_required_values_missing[t])
  // Effect: ValidationError, no AWS or config mutation
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = ValidationError
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Safety: init success always establishes current integrity
assert init_preserves_current_integrity {
  always (all a : Alias, iid : InstanceId, t : Template |
    init_success[a, iid, t] implies after current_integrity)
}

// Safety: consistency error explicitly surfaces divergence
assert consistency_error_when_aws_mutated_local_failed {
  always (
    (CommandState.awsMutated' = True and CommandState.configMutated' = False)
      implies CommandState.lastOutcome' = ConsistencyError)
}
```

### Requirement: Add Command Contract [BOX-DOMAIN-ADD]
WHEN `add <instance-id> <alias>` succeeds, THE devbox domain SHALL add the alias to local tracking and set `current` to that alias.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Capabilities`

#### Scenario: Add Success Sets Current [BOX-ADD-SUCCESS]
WHEN `add` validates the alias and confirms that the instance is describable in the active account and region, THE devbox domain SHALL commit the alias mapping and set `current` to the alias.

**Postcondition:** The new alias is tracked and selected.

#### Scenario: Add Fails Before Commit [BOX-ADD-FAIL]
IF `add` cannot validate the alias or cannot confirm the instance in the active account and region, THEN THE devbox domain SHALL fail without mutating local tracking.

**Postcondition:** Existing aliases and `current` remain unchanged.

```alloy
// --- Add command: track existing instance ---

pred add_success [a : Alias, iid : InstanceId] {
  // Preconditions
  alias_available[a]
  instance_describable[iid]
  config_wellformed
  LockModel.lockState = Free
  // Effect
  Config.boxes' = Config.boxes + (a -> iid)
  Config.current' = a
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = False   // add does not mutate AWS
  CommandState.configMutated' = True
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

pred add_fails [a : Alias, iid : InstanceId] {
  // Guard: alias invalid OR instance not describable
  (alias_tracked[a] or instance_not_describable[iid])
  // Effect: no mutation
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = (alias_tracked[a] implies ValidationError else NotFoundError)
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Safety: add failure never mutates tracking
assert add_fail_no_mutation {
  always (all a : Alias, iid : InstanceId |
    add_fails[a, iid] implies Config.boxes' = Config.boxes)
}
```

### Requirement: Remove Command Contract [BOX-DOMAIN-RM]
WHEN `rm <alias> [--terminate]` is invoked, THE devbox domain SHALL remove the alias locally, clear `current` if it pointed to that alias, and only request AWS termination when `--terminate` is explicitly supplied.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Local Remove Without Termination [BOX-RM-LOCAL]
WHEN `rm <alias>` is invoked without `--terminate`, THE devbox domain SHALL remove the alias locally even if the tracked instance is stale.

**Postcondition:** The alias no longer exists in local tracking and no AWS termination is attempted.

#### Scenario: Termination Accepted But Local Commit Fails [BOX-RM-CONSISTENCY]
IF `rm --terminate` receives accepted termination or already-absent handling from AWS and the subsequent local config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that local tracking may still retain the alias.

**Postcondition:** The command exposes divergence between AWS state and local tracking.

```alloy
// --- Remove command: local-only and terminate variants ---

pred rm_local [a : Alias] {
  // Preconditions
  alias_tracked[a]
  config_wellformed
  LockModel.lockState = Free
  // Effect: remove alias, clear current if it pointed here
  Config.boxes' = Config.boxes - (a -> Config.boxes[a])
  Config.current' = (Config.current = a implies none else Config.current)
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser - (a -> SshUser)
  Config.hasLastConnectAt' = Config.hasLastConnectAt - a
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = False   // no termination without --terminate
  CommandState.configMutated' = True
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

pred rm_terminate_success [a : Alias] {
  // Preconditions
  alias_tracked[a]
  config_wellformed
  LockModel.lockState = Free
  // Effect: AWS termination accepted, then local removal
  Config.boxes' = Config.boxes - (a -> Config.boxes[a])
  Config.current' = (Config.current = a implies none else Config.current)
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser - (a -> SshUser)
  Config.hasLastConnectAt' = Config.hasLastConnectAt - a
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = True
  CommandState.configMutated' = True
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

pred rm_terminate_consistency [a : Alias] {
  // AWS termination accepted but local commit fails
  alias_tracked[a]
  config_wellformed
  LockModel.lockState = Free
  CommandState.awsMutated' = True
  CommandState.configMutated' = False
  // Config unchanged because commit failed
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = ConsistencyError
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Safety: rm without --terminate never contacts AWS
assert rm_local_no_aws {
  always (all a : Alias |
    rm_local[a] implies CommandState.awsMutated' = False)
}

// Safety: rm --terminate does not remove local tracking before AWS accepts
assert rm_terminate_order {
  always (all a : Alias |
    rm_terminate_success[a] implies CommandState.awsMutated' = True)
}
```

### Requirement: Switch Command Contract [BOX-DOMAIN-SWITCH]
WHEN `switch <alias>` is invoked for a tracked alias, THE devbox domain SHALL set `current` to that alias without mutating any other tracked box.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Switch Success [BOX-SWITCH-SUCCESS]
WHEN the user invokes `switch` for an existing alias, THE devbox domain SHALL commit `current = alias`.

**Postcondition:** Future current-box commands target the switched alias.

#### Scenario: Switch Missing Alias [BOX-SWITCH-FAIL]
IF the user invokes `switch` for an alias that is not tracked, THEN THE devbox domain SHALL fail without any AWS dependency.

**Postcondition:** The current selection remains unchanged.

```alloy
// --- Switch command: local pointer update ---

pred switch_success [a : Alias] {
  // Preconditions
  alias_tracked[a]
  config_wellformed
  LockModel.lockState = Free
  // Effect: only current changes
  Config.boxes' = Config.boxes
  Config.current' = a
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = False
  CommandState.configMutated' = True
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

pred switch_fails [a : Alias] {
  // Guard: alias not tracked
  alias_available[a]
  // Effect: no mutation, no AWS
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = NotFoundError
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Safety: switch never mutates boxes
assert switch_boxes_unchanged {
  always (all a : Alias |
    (switch_success[a] or switch_fails[a]) implies Config.boxes' = Config.boxes)
}

// Safety: switch never contacts AWS
assert switch_no_aws {
  always (all a : Alias |
    (switch_success[a] or switch_fails[a]) implies CommandState.awsMutated' = False)
}
```

### Requirement: Atomic Config Mutation [BOX-ADAPTER-ATOMIC]
WHEN a mutating registry command commits config state, THE devbox adapter SHALL use single-writer advisory locking, temp-file write, `fsync`, atomic replace, and best-effort stale-lock recovery.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`

#### Scenario: Successful Atomic Replace [BOX-ATOMIC-SUCCESS]
WHEN the adapter acquires the advisory lock and completes the write flow successfully, THE devbox adapter SHALL leave a schema-valid committed config and remove the lock file on normal completion.

**Postcondition:** The target config path contains the full next config and no partial JSON.

#### Scenario: Live Lock Rejected [BOX-ATOMIC-FAIL]
IF the advisory lock is held by a live, recent process and is not stale, THEN THE devbox adapter SHALL reject the mutation with a config failure instead of merging concurrent writers.

**Postcondition:** The previously committed config remains unchanged.

```alloy
// --- Atomic config mutation: single-writer lock protocol ---
// Issue 17 fix: Commands atomically acquire-mutate-release in a single transition
// (guard: lockState = Free, effect: lockState' = Free). External processes may hold
// the lock, which is modeled via external_lock_acquired/external_lock_holder_dies.

// Issue 8 fix: External lock acquisition allows Held state to be reachable,
// making lock_rejected and stale recovery non-vacuous.
pred external_lock_acquired {
  LockModel.lockState = Free
  LockModel.lockState' = Held
  LockModel.lockHolderAlive' = True
  // Frame: no config change during external acquisition
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CommandState.lastOutcome
  CommandState.awsMutated' = CommandState.awsMutated
  CommandState.configMutated' = CommandState.configMutated
}

pred external_lock_holder_dies {
  LockModel.lockState = Held
  LockModel.lockHolderAlive = True
  LockModel.lockHolderAlive' = False
  LockModel.lockState' = LockModel.lockState
  // Frame
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CommandState.lastOutcome
  CommandState.awsMutated' = CommandState.awsMutated
  CommandState.configMutated' = CommandState.configMutated
}

pred lock_rejected {
  // Lock is held by a live, recent process
  LockModel.lockState = Held
  LockModel.lockHolderAlive = True
  // Effect: mutation rejected
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = ConfigError
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
}

// Issue 8 fix: single_writer now verifies that config mutation requires lock = Free
// (instead of vacuously asserting that Held implies no change)
assert single_writer {
  always (
    Config.boxes' != Config.boxes implies LockModel.lockState = Free)
}

// Safety: committed config is always well-formed after successful mutation
assert committed_config_valid {
  always (CommandState.configMutated' = True implies after config_wellformed)
}
```

### Requirement: List Output Format [BOX-CLI-LIST-FORMAT]
WHEN `devbox list` prints tracked boxes, THE devbox CLI SHALL render a human-readable terminal table with columns: current-box indicator, alias, instance ID, instance type, and state.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Table With Current Indicator [BOX-LIST-TABLE]
WHEN tracked boxes exist and AWS enrichment succeeds, THE devbox CLI SHALL print a table where the current box row is marked with `*` in the first column and other rows show a space.

**Postcondition:** The table includes alias, instance ID, instance type, and one of the state values: `running`, `stopped`, `pending`, `stopping`, `shutting-down`, `terminated`, `stale`, or `unknown`.

#### Scenario: Empty Registry Prints Message [BOX-LIST-EMPTY]
WHEN no boxes are tracked, THE devbox CLI SHALL print the single line `No boxes tracked`.

**Postcondition:** No table header or empty table is rendered.

```alloy
// --- List command: read-only enrichment with graceful degradation ---

// List enrichment states for each tracked box
abstract sig EnrichState {}
one sig Enriched, Stale, Unknown extends EnrichState {}

pred list_command {
  // List is always read-only: no config mutation
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CmdSuccess
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

// Safety: list never mutates config regardless of AWS availability
assert list_never_mutates {
  always (list_command implies (
    Config.boxes' = Config.boxes and
    Config.current' = Config.current and
    CommandState.awsMutated' = False))
}

// Safety: list always succeeds (graceful degradation)
assert list_always_succeeds {
  always (list_command implies CommandState.lastOutcome' = CmdSuccess)
}
```

### Requirement: Config Permissions [BOX-ADAPTER-PERMS]
WHEN the config-store adapter creates config or lock files, THE devbox adapter SHALL create them with mode `0600` (read-write for the user only).

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`

#### Scenario: Config Created With Standard Permissions [BOX-PERMS-CONFIG]
WHEN a mutating command creates `~/.config/devbox.json` for the first time, THE devbox adapter SHALL set file mode `0600` (read-write for the user only).

**Postcondition:** The config file is readable by the owner and group/others.

### Requirement: Stale Lock Specification [BOX-ADAPTER-STALELOCK]
WHEN the advisory lock file exists and the current process needs to acquire it, THE devbox adapter SHALL detect staleness using PID validity, PID liveness, and a 5-minute mtime threshold.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Stale Lock By Dead PID [BOX-STALELOCK-PID]
WHEN the lock file contains a PID that does not correspond to a running process, THE devbox adapter SHALL treat the lock as stale, remove it, and retry acquisition once.

**Postcondition:** The stale lock does not permanently block the mutation.

#### Scenario: Stale Lock By Age [BOX-STALELOCK-AGE]
WHEN the lock file mtime is older than 5 minutes, THE devbox adapter SHALL treat the lock as stale regardless of PID liveness.

**Postcondition:** Long-orphaned locks are recovered automatically.

#### Scenario: Live Lock Not Stolen [BOX-STALELOCK-LIVE]
WHEN the lock file contains a valid PID of a running process and the mtime is within 5 minutes, THE devbox adapter SHALL reject the mutation with `ConfigError`.

**Postcondition:** A live, recent lock holder is never preempted.

```alloy
// --- Stale lock recovery protocol ---

pred stale_by_dead_pid {
  LockModel.lockState = Held
  LockModel.lockHolderAlive = False
  // Recovery: remove stale lock, retry once
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
  // Frame: no config change during recovery
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CommandState.lastOutcome
  CommandState.awsMutated' = CommandState.awsMutated
  CommandState.configMutated' = CommandState.configMutated
}

pred stale_by_age {
  // Lock held but older than 5 minutes (modeled as state rather than time)
  LockModel.lockState = StaleByAge
  // Recovery: same as dead PID
  LockModel.lockState' = Free
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CommandState.lastOutcome
  CommandState.awsMutated' = CommandState.awsMutated
  CommandState.configMutated' = CommandState.configMutated
}

pred live_lock_blocks {
  // Lock held, holder alive, within 5 minutes
  LockModel.lockState = Held
  LockModel.lockHolderAlive = True
  // Rejection: ConfigError
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = ConfigError
  CommandState.awsMutated' = False
  CommandState.configMutated' = False
}

// Issue 18 fix: live lock holder stays Held (not the weaker != Free || == self)
assert live_lock_never_stolen {
  always (
    (LockModel.lockState = Held and LockModel.lockHolderAlive = True)
      implies LockModel.lockState' = Held)
}

// Issue 19 fix: leads-to formulation instead of always-eventually-implies
pred stale_lock_fairness {
  always (
    (LockModel.lockState = Held and LockModel.lockHolderAlive = False)
      implies eventually LockModel.lockState = Free)
  always (
    LockModel.lockState = StaleByAge
      implies eventually LockModel.lockState = Free)
}

assert stale_locks_recovered {
  stale_lock_fairness implies
    always ((LockModel.lockState in (Held + StaleByAge) and
             (LockModel.lockHolderAlive = False or LockModel.lockState = StaleByAge))
      implies eventually LockModel.lockState = Free)
}
```

### Requirement: Remove Clears Current [BOX-DOMAIN-RM-CURRENT]
WHEN `rm` removes an alias that is the current box, THE devbox domain SHALL clear `current` by removing it from config entirely rather than reassigning it to another box.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Current Becomes Absent After Remove [BOX-RM-CURRENT-CLEAR]
WHEN `rm <alias>` removes the alias that is also `current`, THE devbox domain SHALL set `current` to absent in the committed config.

**Postcondition:** No automatic reassignment occurs and subsequent current-box commands require explicit `switch`.

```alloy
// --- Remove clears current: no auto-reassignment ---

// Safety: removing current alias always clears current (never reassigns)
assert rm_current_clears_not_reassigns {
  always (all a : Alias |
    (rm_local[a] and Config.current = a) implies no Config.current')
}

// Safety: removing non-current alias preserves current
assert rm_noncurrent_preserves {
  always (all a : Alias |
    (rm_local[a] and Config.current != a) implies Config.current' = Config.current)
}
```

### Requirement: Init Template Field Allowlist [BOX-DOMAIN-INIT-ALLOWLIST]
WHEN `init <alias> <template-file>` processes template JSON, THE devbox domain SHALL accept only the following top-level fields: `BlockDeviceMappings`, `CapacityReservationSpecification`, `CpuOptions`, `CreditSpecification`, `DisableApiStop`, `DisableApiTermination`, `EbsOptimized`, `EnclaveOptions`, `HibernationOptions`, `IamInstanceProfile`, `ImageId`, `InstanceInitiatedShutdownBehavior`, `InstanceMarketOptions`, `InstanceType`, `KernelId`, `KeyName`, `LicenseSpecifications`, `MaintenanceOptions`, `MetadataOptions`, `Monitoring`, `NetworkInterfaces`, `Placement`, `PrivateDnsNameOptions`, `RamDiskId`, `SecurityGroupIds`, `SecurityGroups`, `TagSpecifications`, and `UserData`.

THE devbox domain SHALL reject `InstanceRequirements` and any unknown top-level key with `ValidationError`.

THE devbox domain SHALL always add `MinCount=1` and `MaxCount=1` to the `run-instances` invocation.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Unknown Template Field Rejected [BOX-INIT-UNKNOWN-FIELD]
IF the template JSON contains a top-level key not in the accepted allowlist, THEN THE devbox domain SHALL fail with `ValidationError` before any AWS call.

**Postcondition:** No instance is launched and no config is mutated.

#### Scenario: InstanceRequirements Rejected [BOX-INIT-REJECT-IR]
IF the template JSON contains `InstanceRequirements`, THEN THE devbox domain SHALL fail with `ValidationError` before any AWS call.

**Postcondition:** No instance is launched and no config is mutated.

### Requirement: Init Conditional Conflict Rules [BOX-DOMAIN-INIT-CONFLICTS]
WHEN `init` processes template JSON that contains `NetworkInterfaces`, THE devbox domain SHALL reject top-level `SecurityGroupIds` and top-level `SecurityGroups` with `ValidationError`, and SHALL require security groups under `NetworkInterfaces[*].Groups`.

WHEN `init` processes template JSON that uses top-level `SecurityGroups` without `NetworkInterfaces`, THE devbox domain SHALL allow the request to proceed and surface any AWS rejection clearly if the account or network context does not support that request shape.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: NetworkInterfaces With Top Level SGs Rejected [BOX-INIT-NI-CONFLICT]
IF the template contains both `NetworkInterfaces` and top-level `SecurityGroupIds` or `SecurityGroups`, THEN THE devbox domain SHALL fail with `ValidationError` before any AWS call.

**Postcondition:** No instance is launched and no config is mutated.

#### Scenario: SecurityGroups Without NetworkInterfaces Allowed [BOX-INIT-SG-ALLOWED]
WHEN the template uses top-level `SecurityGroups` without `NetworkInterfaces`, THE devbox domain SHALL pass the request through and relay any AWS rejection clearly.

**Postcondition:** AWS is authoritative for whether the request shape is valid in the active context.

```alloy
// --- Template validation: structural constraints on init input ---
// Issue 20 fix: Template is now connected to init events via init_success[a, iid, t]
// and init_template_rejected[a, t], making these assertions non-vacuous.

abstract sig TemplateField {}
one sig NetworkInterfacesField, SecurityGroupIdsField, SecurityGroupsField,
        ImageIdField, IamProfileField, UnknownField, InstanceReqField extends TemplateField {}

sig Template {
  fields : set TemplateField
}

pred template_valid [t : Template] {
  // No unknown fields or InstanceRequirements
  no (t.fields & (UnknownField + InstanceReqField))
  // NetworkInterfaces conflict: NI present implies no top-level SG fields
  NetworkInterfacesField in t.fields implies
    no (t.fields & (SecurityGroupIdsField + SecurityGroupsField))
}

pred template_invalid [t : Template] {
  not template_valid[t]
}

// Safety: invalid template blocks all AWS and config effects
assert invalid_template_no_launch {
  always (all a : Alias, iid : InstanceId, t : Template |
    template_invalid[t] implies not init_success[a, iid, t])
}
```

### Requirement: Required Tag Validation Values [BOX-DOMAIN-TAGS-VALUES]
WHEN `init` validates required tags after merge, THE devbox domain SHALL enforce these value constraints:

- `env`: must be one of `prod`, `preprod`, `staging`, `dev`
- `service`: must equal `devbox`
- `version`: must be 7 to 40 characters, with `0000000` allowed as the built-in placeholder default
- `customer-data`: must be one of `true`, `false`
- `team`: must be a non-empty short identifier

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Invalid Tag Value Rejected [BOX-TAGS-VALUE-FAIL]
IF any required tag has an empty or disallowed value after merge, THEN THE devbox domain SHALL fail with `ValidationError` before any AWS call.

**Postcondition:** No instance is launched with invalid tag values.

### Requirement: Tag Merge Precedence [BOX-DOMAIN-TAGS-MERGE]
WHEN `init` builds AWS instance tags, THE devbox domain SHALL apply this precedence order:

1. built-in required tag defaults
2. `config.defaults.tags`
3. template `TagSpecifications` for `ResourceType=instance`
4. forced `Name=<alias>` override
5. required-tag validation

Additional rules:
- `devbox` always emits exactly one merged `TagSpecification` for `ResourceType=instance`
- template `TagSpecifications` for non-instance resource types pass through unchanged
- if the template also contains an `instance` `TagSpecification`, its tags are merged rather than duplicated
- `Name` from the template is ignored and replaced with the alias

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Template Name Tag Overridden [BOX-TAGS-NAME-OVERRIDE]
WHEN the template includes a `Name` tag in its instance `TagSpecification`, THE devbox domain SHALL replace it with the alias.

**Postcondition:** The launched instance `Name` tag equals the alias regardless of template content.

#### Scenario: Non Instance TagSpecs Preserved [BOX-TAGS-NONINSTANCE]
WHEN the template includes `TagSpecifications` for non-instance resource types, THE devbox domain SHALL pass them through unchanged.

**Postcondition:** Volume or other resource-type tags from the template are not lost or merged into the instance tags.

```alloy
// --- Tag merge: precedence model ---
// Tags are modeled as key-value pairs; merge applies override semantics.

sig TagKey {}
sig TagValue {}
one sig NameKey extends TagKey {}

// Tag sources in precedence order (lowest to highest)
abstract sig TagSource {}
one sig BuiltinDefaults, ConfigDefaults, TemplateTags, ForcedName extends TagSource {}

// The merge function always produces a final tag set where:
// - Higher-precedence sources override lower
// - Name is always forced to alias value
// - Non-instance TagSpecs pass through unchanged

// This is modeled structurally rather than behaviorally since tag merge
// is a pure function, not a state transition.

pred tag_merge_postcondition [finalTags : TagKey -> TagValue, aliasTag : TagValue] {
  // Name tag is always the alias
  finalTags[NameKey] = aliasTag
  // All required tags must be present and valid (modeled abstractly)
  some finalTags
}

// Issue 9 fix: verifies tag_merge_postcondition actually enforces Name = alias
assert name_tag_always_alias {
  all finalTags : TagKey -> TagValue, aliasTag : TagValue |
    tag_merge_postcondition[finalTags, aliasTag] implies finalTags[NameKey] = aliasTag
}
```

### Requirement: UserData Pass-Through [BOX-DOMAIN-INIT-USERDATA]
WHEN template JSON contains a `UserData` field, THE devbox domain SHALL pass the value through unchanged to `aws ec2 run-instances` without modifying, interpreting, validating, or base64-encoding it.

Values such as `file:~/some-file.sh` MUST be preserved exactly because AWS CLI handles special prefixes and base64 encoding behavior itself.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: UserData File Prefix Preserved [BOX-INIT-USERDATA-FILE]
WHEN the template `UserData` value begins with `file:`, THE devbox domain SHALL pass it unchanged to `aws ec2 run-instances`.

**Postcondition:** The AWS CLI receives the exact `UserData` string from the template without transformation.

```alloy
// --- UserData pass-through: identity preservation ---
// UserData is modeled as an opaque value that must be preserved exactly.
// This is a refinement property: input = output for UserData.

sig UserDataValue {}

pred userdata_passthrough [input : lone UserDataValue, output : lone UserDataValue] {
  output = input  // strict identity: no transformation
}

// Safety: UserData is never modified by devbox
assert userdata_identity {
  all input : UserDataValue, output : UserDataValue |
    userdata_passthrough[input, output] implies input = output
}
```

### Requirement: Config Creation Policy [BOX-DOMAIN-CONFIG-CREATION]
WHEN a mutating command encounters a missing config file, THE devbox domain SHALL synthesize first-run config containing:

- `boxes = {}`
- no `current`
- `defaults.tags` with built-in required tag defaults only

THE devbox domain SHALL NOT invent environment-specific `ImageId` or `IamInstanceProfile` values in synthesized first-run config.

WHEN `init` proceeds after first-run synthesis or config load, THE devbox domain SHALL fail with `ValidationError` if `ImageId` or `IamInstanceProfile` is absent after merging template values over config defaults.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Init Fails Without ImageId After Merge [BOX-CONFIG-MISSING-IMAGEID]
IF neither the template nor config defaults supply `ImageId`, THEN THE devbox domain SHALL fail with `ValidationError` before any AWS call.

**Postcondition:** No instance is launched with a missing AMI.

#### Scenario: Init Fails Without IamInstanceProfile After Merge [BOX-CONFIG-MISSING-IAM]
IF neither the template nor config defaults supply `IamInstanceProfile`, THEN THE devbox domain SHALL fail with `ValidationError` before any AWS call.

**Postcondition:** No instance is launched without an instance profile.

```alloy
// --- Config creation policy: required launch values ---

pred init_required_values_present [t : Template] {
  ImageIdField in t.fields
  IamProfileField in t.fields
}

pred init_required_values_missing [t : Template] {
  ImageIdField not in t.fields or IamProfileField not in t.fields
}

// Safety: no instance launched without required values
assert no_launch_without_required_values {
  always (all a : Alias, iid : InstanceId, t : Template |
    init_required_values_missing[t] implies not init_success[a, iid, t])
}
```

### Requirement: List Batched Describe Strategy [BOX-DOMAIN-LIST-BATCH]
WHEN `devbox list` enriches tracked boxes with AWS state, THE devbox domain SHALL collect all tracked instance IDs and issue a single `aws ec2 describe-instances` call for the full set when possible.

If the tracked set exceeds AWS CLI per-call limits, THE devbox domain SHALL split the request into bounded batches.

Instances returned by AWS are enriched with live state and instance type. Tracked instance IDs omitted from an otherwise successful AWS response are shown as `stale`. If a full enrichment batch fails because AWS is unavailable, credentials are missing, or the local `aws` executable is absent, THE devbox CLI SHALL still succeed and show all rows as `unknown`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Single Batch Enrichment [BOX-LIST-BATCH-SINGLE]
WHEN all tracked instance IDs fit within a single AWS CLI call, THE devbox domain SHALL issue one `describe-instances` call rather than one call per alias.

**Postcondition:** API call count is minimized to reduce throttling risk.

#### Scenario: AWS Unavailable Degrades Gracefully [BOX-LIST-BATCH-UNAVAIL]
WHEN the enrichment batch fails because AWS is unreachable or the `aws` executable is absent, THE devbox CLI SHALL still succeed and render all rows with state `unknown`.

**Postcondition:** Local tracking visibility is never lost due to AWS enrichment failure.

```alloy
// --- List graceful degradation ---
// List always succeeds regardless of AWS enrichment outcome.
// This is a liveness property: list never blocks on AWS failure.

assert list_never_fails_on_aws_unavailable {
  always (list_command implies CommandState.lastOutcome' = CmdSuccess)
}

// Safety: list never loses local tracking visibility
assert list_shows_all_tracked {
  always (list_command implies Config.boxes' = Config.boxes)
}
```

### Requirement: Remove Without Terminate Warning [BOX-DOMAIN-RM-WARN]
WHEN `rm <alias>` is invoked without `--terminate`, THE devbox CLI SHALL print a warning that the AWS resources associated with the removed alias may still exist.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Local Remove Warns About AWS Resources [BOX-RM-WARN-MSG]
WHEN `rm <alias>` succeeds without `--terminate`, THE devbox CLI SHALL emit a warning to stderr indicating that the tracked instance may still be running in AWS.

**Postcondition:** The user is informed that local removal does not affect AWS resource lifecycle.

```alloy
// --- Transition system ---

pred stutter {
  Config.boxes' = Config.boxes
  Config.current' = Config.current
  Config.defaultSshUser' = Config.defaultSshUser
  Config.boxSshUser' = Config.boxSshUser
  Config.hasLastConnectAt' = Config.hasLastConnectAt
  CommandState.lastOutcome' = CommandState.lastOutcome
  CommandState.awsMutated' = CommandState.awsMutated
  CommandState.configMutated' = CommandState.configMutated
  LockModel.lockState' = LockModel.lockState
  LockModel.lockHolderAlive' = LockModel.lockHolderAlive
}

pred init_state {
  no Config.boxes
  no Config.current
  no Config.boxSshUser
  no Config.hasLastConnectAt
  LockModel.lockState = Free
  LockModel.lockHolderAlive = True
  no CommandState.lastOutcome
  CommandState.awsMutated = False
  CommandState.configMutated = False
}

fact transitions {
  init_state and always (
    // Registry commands (issue 20: Template connected via init events)
    (some a : Alias, iid : InstanceId, t : Template | init_success[a, iid, t] or init_consistency_error[a, iid, t])
    or (some a : Alias, t : Template | init_template_rejected[a, t])
    or (some a : Alias, iid : InstanceId | add_success[a, iid] or add_fails[a, iid])
    or (some a : Alias | rm_local[a] or rm_terminate_success[a] or rm_terminate_consistency[a])
    or (some a : Alias | switch_success[a] or switch_fails[a])
    // Read-only
    or list_command
    or list_no_config
    or informational_command
    // Rejections
    or (some a : Alias | missing_alias_rejected[a])
    // Lock protocol (issue 8: external lock events make Held reachable)
    or lock_rejected
    or live_lock_blocks
    or stale_by_dead_pid
    or stale_by_age
    or external_lock_acquired
    or external_lock_holder_dies
    // Stutter
    or stutter
  )
}

// --- Commands ---

run show_box_registry {} for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 5 steps

run scenario_init_then_switch {
  eventually (some a : Alias | Config.current = a and
    eventually (some a2 : Alias | a2 != a and Config.current = a2))
} for 3 Alias, 3 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 8 steps

check current_always_valid for 4 Alias, 3 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 20 steps expect 0
check no_duplicate_alias for 4 Alias, 3 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 15 steps expect 0
check single_writer for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 10 steps expect 0
check rm_current_clears_not_reassigns for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 15 steps expect 0
check rm_local_no_aws for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 10 steps expect 0
check switch_no_aws for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 10 steps expect 0
check list_never_mutates for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 10 steps expect 0
check undescribable_never_tracked for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 15 steps expect 0
check consistency_error_when_aws_mutated_local_failed for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 15 steps expect 0
check no_launch_without_required_values for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 10 steps expect 0
check live_lock_never_stolen for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 10 steps expect 0
check stale_locks_recovered for 3 Alias, 2 InstanceId, 2 SshUser, 1 Template, 1 AwsContext, 2 TagKey, 2 TagValue, 1 UserDataValue, 20 steps
```
