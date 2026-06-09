---
title: RemoteAccess
---

## Purpose

Define the remote-access behavior for `devbox connect` and upload-only `devbox cp` over AWS SSM-backed SSH, including invocation-time SSH-user overrides, readiness checks, remote-path safety, temporary key staging, bounded cleanup, and post-success consistency handling.
The purpose of this capability is to preserve trust across local state, AWS state, and remote-host state by following the archived `devbox-core` design's explicit validation gates, bounded waits, and cross-system failure reporting.

```alloy
module RemoteAccess
open util/boolean

// --- Remote access domain vocabulary ---

sig Instance {
  var running : one Bool,
  var ssmReady : one Bool
}

sig SshUser {}
sig Alias {
  instanceRef : one Instance,
  boxSshUser : lone SshUser
}

one sig Defaults {
  sshUser : lone SshUser
}

// Remote access session phases
abstract sig Phase {}
one sig Idle, Resolving, WaitingSSM, Staging, Transporting, Cleanup, Done, Failed extends Phase {}

one sig Session {
  var phase : one Phase,
  var ssmTicksRemaining : one Int,   // 2-min SSM readiness timeout (24 ticks * 5s)
  var keyStaged : one Bool,
  var transportStarted : one Bool,
  var cleanupScheduled : one Bool,
  var lastConnectUpdated : one Bool
}

// Outcome vocabulary
abstract sig Outcome {}
one sig Success, InstanceStateError, TimeoutError, TransportError, ValidationError, ConsistencyError extends Outcome {}

one sig CommandResult {
  var outcome : lone Outcome,
  var exitCode : lone Int
}

// Current box selection
var sig current in Alias {}

// Remote path model for cp
sig RemotePath {
  hasControlChars : one Bool,
  isEmpty : one Bool
}

// Copy transport phases
abstract sig CpPhase {}
one sig CpUploading, CpFinalizing, CpDone, CpFailed extends CpPhase {}

one sig CpState {
  var cpPhase : one CpPhase,
  var uploadedToTemp : one Bool,
  var finalizedAtDest : one Bool
}

// Key storage: agent preference and temp-key lifecycle
abstract sig KeySource {}
one sig AgentKey, TempKey extends KeySource {}

one sig KeyStore {
  var source : one KeySource,
  var tempFilesExist : one Bool
}
```

## Requirements

**CLI Layer:** command surface, parsing, output, and composition of domain+adapters.

### Requirement: CLI Remote Access Commands [REMOTE-CLI-CMDS]
THE devbox CLI SHALL provide `connect` and `cp <local> <remote>` commands, each supporting an invocation-time `--ssh-user <user>` override.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Capabilities`

#### Scenario: Runtime SSH User Override [REMOTE-CLI-SSHUSER]
WHEN the user invokes `connect` or `cp` with `--ssh-user <user>`, THE devbox CLI SHALL pass that override into SSH-user resolution for the command.

**Postcondition:** The invocation override becomes the highest-precedence SSH-user input.

##### Evidence
- Implementation: [index.ts:86 parseOptionalSshUser()](/src/index.ts#L86), [index.ts:237 dispatch()](/src/index.ts#L237), [connect.ts:80 runConnectCommand()](/src/cli/commands/connect.ts#L80), [cp.ts:94 runCpCommand()](/src/cli/commands/cp.ts#L94), [ssh-user.ts:55 resolveSshUser()](/src/domain/ssh-user.ts#L55)
- Test: [remote-access.contract.test.ts:51 invocation override wins](/test/contract/remote-access.contract.test.ts#L51), [remote-commands.integration.test.ts:98 connect forwards invocation ssh user override to remote-access preconditions](/test/integration/remote-commands.integration.test.ts#L98), [remote-commands.integration.test.ts:189 cp forwards invocation ssh user override to remote-access preconditions](/test/integration/remote-commands.integration.test.ts#L189)
- Test (property): [ssh-user.property.test.ts:13 invocationOverride takes highest precedence](/test/property/ssh-user.property.test.ts#L13), [ssh-user.property.test.ts:84 rejects invocation override containing embedded control characters](/test/property/ssh-user.property.test.ts#L84)
- Example:
```ts
const { resolveSshUser } = await import("./src/domain/ssh-user.ts");
const result = resolveSshUser({ invocationOverride: "ubuntu", box: { instanceId: "i-alpha123", sshUser: "ec2-user" }, defaults: { tags: { env: "dev", service: "devbox", version: "0000000", "customer-data": "false", team: "devbox" }, sshUser: "defaultuser" } }); //=> type Object
result.ok; //=> true
(result.ok ? result.value : ""); //=> ubuntu
```

#### Scenario: Missing Current Box Rejected [REMOTE-CLI-FAIL]
IF the user invokes `connect` or `cp` and no current box is selected, THEN THE devbox CLI SHALL fail before any remote-access setup begins.

**Postcondition:** No staging, transport, or `lastConnectAt` update occurs.

##### Evidence
- Implementation: [context.ts:46 resolveCurrentBox()](/src/domain/context.ts#L46), [remote-access.ts:106 resolveRemoteAccessPreconditions()](/src/cli/remote-access.ts#L106)
- Test: [remote-access.contract.test.ts:87 no current -> error](/test/contract/remote-access.contract.test.ts#L87), [remote-access.contract.test.ts:95 current not in boxes -> error](/test/contract/remote-access.contract.test.ts#L95)
- Example:
```ts
const { resolveCurrentBox } = await import("./src/domain/context.ts");
const config = {
  boxes: { alpha: { instanceId: "i-alpha123" } },
  defaults: { tags: { env: "dev", service: "devbox", version: "0000000", "customer-data": "false", team: "devbox" } },
};
const result = resolveCurrentBox(config); //=> type Object
result.ok; //=> false
result.error.category; //=> ValidationError
```

#### Requirement model

```alloy
// --- CLI precondition: current box required ---

pred no_current_box {
  no current
}

pred remote_rejected_no_current {
  // Guard: no current box
  no_current_box
  // Effect: immediate failure, no phase progression
  Session.phase' = Failed
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  Session.keyStaged' = False
  Session.transportStarted' = False
  Session.cleanupScheduled' = False
  Session.lastConnectUpdated' = False
  CommandResult.outcome' = InstanceStateError
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// Safety: no remote-access setup without current box
assert no_staging_without_current {
  always (no_current_box implies Session.keyStaged' = False)
}

// Safety: no transport without current box
assert no_transport_without_current {
  always (no_current_box implies Session.transportStarted' = False)
}
```

- - -

**Domain Layer:** deterministic business rules and state machine.

### Requirement: Remote Access Preconditions [REMOTE-DOMAIN-PRECOND]
WHILE `connect` or `cp` is running, THE devbox domain SHALL require the current instance to be `running`, require the instance to become SSM-ready within the readiness timeout, and require all documented local dependencies for the requested command.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Assumptions and Dependencies`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Running And Ready Continues [REMOTE-PRECOND-READY]
WHILE the current instance is `running` and becomes SSM-ready within 2 minutes, THE devbox domain SHALL allow remote-access transport setup to proceed.

**Postcondition:** The command may start the staging and transport flow.

##### Evidence
- Implementation: [remote-access.ts:106 resolveRemoteAccessPreconditions()](/src/cli/remote-access.ts#L106), [ec2-wait.ts:186 waitForSsmOnline()](/src/domain/ec2-wait.ts#L186), [ssh-cli.ts:224 ensureSshKeyMaterial()](/src/adapters/ssh-cli.ts#L224), [ssh-cli.ts:313 stageTemporarySshKey()](/src/adapters/ssh-cli.ts#L313)
- Test: [remote-access.integration.test.ts:76 continues to staged transport setup when instance is running and SSM-ready](/test/integration/remote-access.integration.test.ts#L76), [ec2-wait.integration.test.ts:109 returns success immediately when getStatus returns Online](/test/integration/ec2-wait.integration.test.ts#L109), [ec2-wait.integration.test.ts:118 returns success after getStatus returns undefined then Online](/test/integration/ec2-wait.integration.test.ts#L118)
- Example:
```ts
const { waitForSsmOnline } = await import("./src/domain/ec2-wait.ts");
const { ok } = await import("./src/domain/result.ts");
const result = await waitForSsmOnline(() => Promise.resolve(ok("Online"))); //=> type Object
result.ok; //=> true
```

#### Scenario: Non Running Or Unready Rejected [REMOTE-PRECOND-FAIL]
IF the current instance is not `running` or does not become SSM-ready within 2 minutes, THEN THE devbox domain SHALL fail with `InstanceStateError` or `TimeoutError` before SSH transport begins.

**Postcondition:** No SSH or SCP session is started.

##### Evidence
- Implementation: [remote-access.ts:106 resolveRemoteAccessPreconditions()](/src/cli/remote-access.ts#L106), [ec2-wait.ts:186 waitForSsmOnline()](/src/domain/ec2-wait.ts#L186)
- Test: [remote-access.integration.test.ts:104 rejects non-running instances before SSM polling or key staging](/test/integration/remote-access.integration.test.ts#L104), [remote-access.integration.test.ts:127 propagates SSM readiness timeout before key staging](/test/integration/remote-access.integration.test.ts#L127), [ec2-wait.integration.test.ts:134 returns timeout error when getStatus never returns Online](/test/integration/ec2-wait.integration.test.ts#L134)

#### Requirement model

```alloy
// --- Precondition checking: running + SSM ready within 2 minutes ---

pred instance_running [a : Alias] {
  a.instanceRef.running = True
}

pred instance_not_running [a : Alias] {
  a.instanceRef.running = False
}

pred instance_ssm_ready [a : Alias] {
  a.instanceRef.ssmReady = True
}

// Begin precondition check: verify instance is running
pred check_running [a : Alias] {
  // Guard
  a in current
  Session.phase = Idle
  instance_running[a]
  // Effect: advance to SSM waiting
  Session.phase' = WaitingSSM
  Session.ssmTicksRemaining' = 24   // 24 ticks * 5s = 2 minutes
  Session.keyStaged' = Session.keyStaged
  Session.transportStarted' = Session.transportStarted
  Session.cleanupScheduled' = Session.cleanupScheduled
  Session.lastConnectUpdated' = Session.lastConnectUpdated
  CommandResult.outcome' = CommandResult.outcome
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// Instance not running: immediate rejection
pred rejected_not_running [a : Alias] {
  a in current
  Session.phase = Idle
  instance_not_running[a]
  // Effect: fail with InstanceStateError
  Session.phase' = Failed
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  Session.keyStaged' = False
  Session.transportStarted' = False
  Session.cleanupScheduled' = False
  Session.lastConnectUpdated' = False
  CommandResult.outcome' = InstanceStateError
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// SSM poll tick: check readiness within bounded time
pred ssm_poll_tick [a : Alias] {
  a in current
  Session.phase = WaitingSSM
  Session.ssmTicksRemaining > 0
  // SSM may become ready
  (a.instanceRef.ssmReady' = True or a.instanceRef.ssmReady' = False)
  // Check if ready now
  (a.instanceRef.ssmReady' = True) implies {
    Session.phase' = Staging
    Session.ssmTicksRemaining' = sub[Session.ssmTicksRemaining, 1]
  } else {
    Session.phase' = WaitingSSM
    Session.ssmTicksRemaining' = sub[Session.ssmTicksRemaining, 1]
  }
  // Frame
  Session.keyStaged' = Session.keyStaged
  Session.transportStarted' = Session.transportStarted
  Session.cleanupScheduled' = Session.cleanupScheduled
  Session.lastConnectUpdated' = Session.lastConnectUpdated
  CommandResult.outcome' = CommandResult.outcome
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  a.instanceRef.running' = a.instanceRef.running
  all i : Instance - a.instanceRef | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// SSM timeout: 2 minutes elapsed without readiness
pred ssm_timeout [a : Alias] {
  a in current
  Session.phase = WaitingSSM
  Session.ssmTicksRemaining = 0
  a.instanceRef.ssmReady = False
  // Effect: TimeoutError
  Session.phase' = Failed
  Session.ssmTicksRemaining' = 0
  Session.keyStaged' = False
  Session.transportStarted' = False
  Session.cleanupScheduled' = False
  Session.lastConnectUpdated' = False
  CommandResult.outcome' = TimeoutError
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// Safety: no SSH transport starts before SSM is ready
assert no_transport_before_ssm_ready {
  always (Session.phase = WaitingSSM implies Session.transportStarted = False)
}

// Safety: non-running instance never reaches staging
assert non_running_never_stages {
  always (all a : current |
    instance_not_running[a] implies Session.phase' != Staging)
}

// Safety: SSM timeout is bounded (always terminates)
// Requires fairness: ssm_poll_tick or ssm_timeout eventually fire when enabled
pred ssm_fairness {
  always (
    (Session.phase = WaitingSSM and Session.ssmTicksRemaining > 0)
      implies eventually (some a : Alias | ssm_poll_tick[a]))
  always (
    (Session.phase = WaitingSSM and Session.ssmTicksRemaining = 0)
      implies eventually (some a : Alias | ssm_timeout[a]))
}

assert ssm_polling_terminates {
  ssm_fairness implies
    always (Session.phase = WaitingSSM implies eventually Session.phase != WaitingSSM)
}
```

### Requirement: SSH User Resolution [REMOTE-DOMAIN-SSHUSER]
WHEN `connect` or `cp` requires an SSH user, THE devbox domain SHALL resolve it using invocation override, then per-box `sshUser`, then `defaults.sshUser`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Defaults SSH User Used [REMOTE-SSHUSER-DEFAULT]
WHEN no invocation override or per-box override is present and `defaults.sshUser` is configured, THE devbox domain SHALL use `defaults.sshUser` for remote access.

**Postcondition:** The remote-access flow has a single resolved SSH user.

##### Evidence
- Implementation: [ssh-user.ts:55 resolveSshUser()](/src/domain/ssh-user.ts#L55)
- Test: [remote-access.contract.test.ts:67 defaults used as fallback](/test/contract/remote-access.contract.test.ts#L67)
- Test (property): [ssh-user.property.test.ts:51 defaults.sshUser used when invocation and box are missing](/test/property/ssh-user.property.test.ts#L51)
- Example:
```ts
const { resolveSshUser } = await import("./src/domain/ssh-user.ts");
const result = resolveSshUser({ box: { instanceId: "i-alpha123" }, defaults: { tags: { env: "dev", service: "devbox", version: "0000000", "customer-data": "false", team: "devbox" }, sshUser: "defaultuser" } }); //=> type Object
result.ok; //=> true
(result.ok ? result.value : ""); //=> defaultuser
```

#### Scenario: Unresolvable SSH User Rejected [REMOTE-SSHUSER-FAIL]
IF no SSH user can be resolved from invocation override, per-box override, or `defaults.sshUser`, THEN THE devbox domain SHALL fail before temporary key staging begins.

**Postcondition:** No remote access is attempted with an implicit or guessed SSH user.

##### Evidence
- Implementation: [ssh-user.ts:55 resolveSshUser()](/src/domain/ssh-user.ts#L55), [remote-access.ts:106 resolveRemoteAccessPreconditions()](/src/cli/remote-access.ts#L106)
- Test: [remote-access.contract.test.ts:75 missing all three fails](/test/contract/remote-access.contract.test.ts#L75)
- Test (property): [ssh-user.property.test.ts:69 returns error when all sources are missing](/test/property/ssh-user.property.test.ts#L69)
- Example:
```ts
const { resolveSshUser } = await import("./src/domain/ssh-user.ts");
const result = resolveSshUser({ box: { instanceId: "i-alpha123" }, defaults: { tags: { env: "dev", service: "devbox", version: "0000000", "customer-data": "false", team: "devbox" } } }); //=> type Object
result.ok; //=> false
result.error.category; //=> ValidationError
```

#### Requirement model

```alloy
// --- SSH user resolution: precedence function ---

fun resolve_ssh_user [invocation : lone SshUser, box : Alias] : lone SshUser {
  (some invocation) implies invocation
  else (some box.boxSshUser) implies box.boxSshUser
  else Defaults.sshUser
}

pred ssh_user_resolvable [invocation : lone SshUser, box : Alias] {
  some resolve_ssh_user[invocation, box]
}

pred ssh_user_unresolvable [invocation : lone SshUser, box : Alias] {
  no resolve_ssh_user[invocation, box]
}

// Safety: no key staging without resolved SSH user
assert no_staging_without_ssh_user {
  always (all a : current |
    ssh_user_unresolvable[none, a] implies Session.keyStaged' = False)
}
```

### Requirement: Connect Session Contract [REMOTE-DOMAIN-CONNECT]
WHEN `connect` succeeds, THE devbox domain SHALL establish an SSM-backed SSH session to the current instance and SHALL update `lastConnectAt` only after session startup succeeds and the subsequent local config commit succeeds.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Connect Success Updates Timestamp [REMOTE-CONNECT-SUCCESS]
WHEN `connect` completes session startup successfully and the local config commit succeeds, THE devbox domain SHALL update `lastConnectAt` for the current tracked box.

**Postcondition:** The tracked box records the last successful remote-access time.

##### Evidence
- Implementation: [connect.ts:80 runConnectCommand()](/src/cli/commands/connect.ts#L80), [ssh-cli.ts:402 startInteractiveSsh()](/src/adapters/ssh-cli.ts#L402)
- Test (integration): [remote-commands.integration.test.ts:76 connect updates lastConnectAt after a successful session](/test/integration/remote-commands.integration.test.ts#L76)

#### Scenario: Connect External Success Local Failure [REMOTE-CONNECT-CONSISTENCY]
IF `connect` succeeds in starting the remote session but the subsequent config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that `lastConnectAt` may be stale locally.

**Postcondition:** Divergence is reported explicitly after external success.

##### Evidence
- Implementation: [connect.ts:80 runConnectCommand()](/src/cli/commands/connect.ts#L80)
- Test (integration): [remote-commands.integration.test.ts:120 connect reports consistency error when commit fails after session success](/test/integration/remote-commands.integration.test.ts#L120)

#### Requirement model

```alloy
// --- Connect session: transport + lastConnectAt update ---

pred connect_success [a : Alias] {
  // Guard: staging complete, transport ready
  a in current
  Session.phase = Transporting
  Session.keyStaged = True
  // Effect: session established, lastConnectAt updated
  Session.phase' = Done
  Session.transportStarted' = True
  Session.lastConnectUpdated' = True
  Session.cleanupScheduled' = True
  Session.keyStaged' = Session.keyStaged
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = Success
  CommandResult.exitCode' = 0
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

pred connect_consistency_error [a : Alias] {
  // Guard: transport succeeded but local commit failed
  a in current
  Session.phase = Transporting
  Session.keyStaged = True
  // Effect: session started externally, but lastConnectAt NOT updated
  Session.phase' = Failed
  Session.transportStarted' = True
  Session.lastConnectUpdated' = False
  Session.cleanupScheduled' = True
  Session.keyStaged' = Session.keyStaged
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = ConsistencyError
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// Safety: lastConnectAt only updated after BOTH external and local success
assert last_connect_requires_both_successes {
  always (Session.lastConnectUpdated' = True implies (
    Session.transportStarted' = True and
    CommandResult.outcome' = Success))
}

// Safety: consistency error surfaces divergence
assert consistency_error_on_local_failure {
  always (
    (Session.transportStarted' = True and Session.lastConnectUpdated' = False)
      implies CommandResult.outcome' = ConsistencyError)
}
```

### Requirement: Copy Transport Contract [REMOTE-DOMAIN-CP]
WHEN `cp <local> <remote>` succeeds, THE devbox domain SHALL upload exactly one regular local file to a temporary path in the destination directory and finalize the destination with an atomic remote move.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Copy Success Finalizes Destination [REMOTE-CP-SUCCESS]
WHEN `cp` validates the local file and remote path, completes upload to a temporary remote path, and completes finalization successfully, THE devbox domain SHALL report success and update `lastConnectAt` only after the local config commit succeeds.

**Postcondition:** The final destination path contains the uploaded file and no partial final-path write occurred.

##### Evidence
- Implementation: [cp.ts:94 runCpCommand()](/src/cli/commands/cp.ts#L94), [ssh-cli.ts:461 uploadFileOverScp()](/src/adapters/ssh-cli.ts#L461), [ssh-cli.ts:517 finalizeRemoteFile()](/src/adapters/ssh-cli.ts#L517)
- Test (integration): [remote-commands.integration.test.ts:168 cp uploads to temp, finalizes, and updates lastConnectAt](/test/integration/remote-commands.integration.test.ts#L168)

#### Scenario: Copy Final Success Local Failure [REMOTE-CP-CONSISTENCY]
IF `cp` completes remote transfer and finalization successfully but the subsequent local config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that the remote file update succeeded while `lastConnectAt` may be stale locally.

**Postcondition:** The command reports cross-system divergence explicitly.

##### Evidence
- Implementation: [cp.ts:94 runCpCommand()](/src/cli/commands/cp.ts#L94)
- Test (integration): [remote-commands.integration.test.ts:197 cp reports consistency error when commit fails after remote success](/test/integration/remote-commands.integration.test.ts#L197)

#### Requirement model

```alloy
// --- Copy transport: temp-upload + atomic move ---

// Upload phase: transfer file to temporary location on remote
pred cp_upload_done [a : Alias] {
  a in current
  Session.phase = Transporting
  Session.keyStaged = True
  CpState.cpPhase = CpUploading
  CpState.uploadedToTemp = False
  // Effect: upload complete, move to finalizing phase
  CpState.cpPhase' = CpFinalizing
  CpState.uploadedToTemp' = True
  CpState.finalizedAtDest' = False
  Session.phase' = Transporting
  Session.transportStarted' = True
  Session.keyStaged' = Session.keyStaged
  Session.cleanupScheduled' = Session.cleanupScheduled
  Session.lastConnectUpdated' = Session.lastConnectUpdated
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = CommandResult.outcome
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

pred cp_success [a : Alias] {
  a in current
  Session.phase = Transporting
  Session.keyStaged = True
  CpState.cpPhase = CpFinalizing
  CpState.uploadedToTemp = True
  // Effect: finalized at destination, lastConnectAt updated
  CpState.cpPhase' = CpDone
  CpState.uploadedToTemp' = True
  CpState.finalizedAtDest' = True
  Session.phase' = Done
  Session.lastConnectUpdated' = True
  Session.transportStarted' = True
  Session.cleanupScheduled' = True
  Session.keyStaged' = Session.keyStaged
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = Success
  CommandResult.exitCode' = 0
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

pred cp_consistency_error [a : Alias] {
  a in current
  Session.phase = Transporting
  Session.keyStaged = True
  CpState.cpPhase = CpFinalizing
  CpState.uploadedToTemp = True
  CpState.finalizedAtDest' = True
  // Remote succeeded but local commit failed
  CpState.cpPhase' = CpFailed
  CpState.uploadedToTemp' = True
  Session.phase' = Failed
  Session.lastConnectUpdated' = False
  Session.transportStarted' = True
  Session.cleanupScheduled' = True
  Session.keyStaged' = Session.keyStaged
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = ConsistencyError
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// Safety: final destination only written via atomic move (never partial)
assert cp_no_partial_destination {
  always (CpState.finalizedAtDest' = True implies CpState.uploadedToTemp = True)
}

// Safety: cp consistency error explicitly surfaces divergence
assert cp_consistency_surfaces_divergence {
  always (
    (CpState.finalizedAtDest' = True and Session.lastConnectUpdated' = False)
      implies CommandResult.outcome' = ConsistencyError)
}
```

### Requirement: Remote Path Validation [REMOTE-DOMAIN-PATH]
WHEN `cp` receives a remote path, THE devbox domain SHALL require the remote path to be non-empty after trimming and SHALL reject ASCII control characters and null bytes before any transport begins.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`

#### Scenario: Safe Remote Path Accepted [REMOTE-PATH-ACCEPT]
WHEN the remote path is non-empty after trimming and contains no ASCII control characters or null bytes, THE devbox domain SHALL allow transport preparation to continue.

**Postcondition:** The path is eligible for conservative POSIX quoting and transmission.

##### Evidence
- Implementation: [remote-path.ts:39 parseRemotePath()](/src/domain/remote-path.ts#L39), [cp.ts:94 runCpCommand()](/src/cli/commands/cp.ts#L94)
- Test: [remote-access.contract.test.ts:9 accepts valid paths](/test/contract/remote-access.contract.test.ts#L9)
- Test (property): [remote-path.property.test.ts:7 succeeds for non-empty strings without control chars](/test/property/remote-path.property.test.ts#L7)
- Example:
```ts
const { parseRemotePath } = await import("./src/domain/remote-path.ts");
const result = parseRemotePath("  /home/ec2-user/config.yaml  "); //=> type Object
result.ok; //=> true
(result.ok ? result.value : ""); //=> /home/ec2-user/config.yaml
```

#### Scenario: Unsafe Remote Path Rejected [REMOTE-PATH-FAIL]
IF the remote path contains an ASCII control character or null byte, THEN THE devbox domain SHALL fail with `ValidationError` before any SSH, SCP, or AWS transport command is executed.

**Postcondition:** The unsafe path never reaches a remote shell.

##### Evidence
- Implementation: [remote-path.ts:39 parseRemotePath()](/src/domain/remote-path.ts#L39), [cp.ts:94 runCpCommand()](/src/cli/commands/cp.ts#L94)
- Test: [remote-access.contract.test.ts:16 rejects empty](/test/contract/remote-access.contract.test.ts#L16), [remote-access.contract.test.ts:23 rejects whitespace-only](/test/contract/remote-access.contract.test.ts#L23), [remote-access.contract.test.ts:30 rejects control chars](/test/contract/remote-access.contract.test.ts#L30), [remote-access.contract.test.ts:37 rejects null bytes](/test/contract/remote-access.contract.test.ts#L37)
- Test (property): [remote-path.property.test.ts:26 fails for strings containing control characters](/test/property/remote-path.property.test.ts#L26), [remote-path.property.test.ts:46 fails for empty or whitespace-only strings](/test/property/remote-path.property.test.ts#L46)
- Example:
```ts
const { parseRemotePath } = await import("./src/domain/remote-path.ts");
const result = parseRemotePath("/home/ec2-user/\u0000config.yaml"); //=> type Object
result.ok; //=> false
result.error.category; //=> ValidationError
```

#### Requirement model

```alloy
// --- Remote path validation: safety gate ---

pred path_safe [p : RemotePath] {
  p.hasControlChars = False
  p.isEmpty = False
}

pred path_unsafe [p : RemotePath] {
  p.hasControlChars = True or p.isEmpty = True
}

pred path_rejected [p : RemotePath] {
  // Guard
  path_unsafe[p]
  Session.phase = Idle   // path validation occurs at command start, before any setup
  // Effect: fail before any transport
  Session.phase' = Failed
  Session.keyStaged' = False
  Session.transportStarted' = False
  Session.cleanupScheduled' = False
  Session.lastConnectUpdated' = False
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = ValidationError
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// Scoped to path_rejected event (not all path atoms globally)
assert unsafe_path_never_transported {
  always (all p : RemotePath |
    path_rejected[p] implies Session.transportStarted' = False)
}

// Safety: unsafe paths never reach a remote shell
assert unsafe_path_never_reaches_remote {
  always (all p : RemotePath |
    path_rejected[p] implies Session.phase' != Transporting)
}
```

### Requirement: Connect Session Lifecycle [REMOTE-DOMAIN-SESSION]
WHEN `connect` hands off the SSH session, THE devbox process SHALL either exec into or wait on the SSH child process and SHALL exit with the SSH process exit code.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Connect Propagates SSH Exit Code [REMOTE-SESSION-EXIT]
WHEN the SSH session terminates, THE devbox connect process SHALL exit with the same exit code as the SSH child process.

**Postcondition:** The caller observes the SSH session's actual exit status.

##### Evidence
- Implementation: [ssh-cli.ts:402 startInteractiveSsh()](/src/adapters/ssh-cli.ts#L402), [connect.ts:80 runConnectCommand()](/src/cli/commands/connect.ts#L80)
- Test (integration): [remote-commands.integration.test.ts:106 connect propagates ssh child exit code](/test/integration/remote-commands.integration.test.ts#L106)

#### Requirement model

```alloy
// --- Session lifecycle: exit code propagation ---

pred session_terminates [sshExit : Int] {
  Session.phase = Done or Session.phase = Failed
  // Exit code is propagated from SSH child
  CommandResult.exitCode' = sshExit
}

// Verifies exit code is set (not the tautology x' = x')
assert exit_code_propagated {
  always (
    Session.phase' = Done implies some CommandResult.exitCode')
}
```

### Requirement: Copy File Size [REMOTE-DOMAIN-FILESIZE]
WHEN `cp` validates the local source file, THE devbox domain SHALL NOT enforce an artificial file size limit.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Large File Accepted [REMOTE-CP-LARGESIZE]
WHEN the local source is a readable regular file of any size, THE devbox domain SHALL allow the transfer to proceed without rejecting it based on file size alone.

**Postcondition:** SCP and network bandwidth are the natural transfer constraints.

##### Evidence
- Implementation: [ssh-cli.ts:181 validateLocalRegularFile()](/src/adapters/ssh-cli.ts#L181), [cp.ts:94 runCpCommand()](/src/cli/commands/cp.ts#L94)
- Test: [ssh-cli.contract.test.ts:37 accepts regular files regardless of large size](/test/contract/ssh-cli.contract.test.ts#L37)
- Example:
```ts
const { writeFile, unlink } = await import("node:fs/promises");
const { validateLocalRegularFile } = await import("./src/adapters/ssh-cli.ts");
const path = "/tmp/devbox-evidence-large-file.bin";
await writeFile(path, "x");
const result = await validateLocalRegularFile(path); //=> type Object
await unlink(path);
result.ok; //=> true
```

#### Requirement model

```alloy
// --- File size: no artificial limit ---
// This is a structural non-constraint: the model deliberately does NOT
// include a file size guard. The absence of a size predicate in the
// cp_success guard formalizes this requirement.

// Allows stutter (Transporting stays Transporting) which is valid.
// The assertion verifies that no OTHER phase is reachable from Transporting —
// only Done, Failed, or staying in Transporting. No artificial size-based rejection.
assert no_artificial_size_limit {
  always (
    (some current and Session.phase = Transporting and Session.keyStaged = True)
      implies Session.phase' in (Done + Failed + Transporting))
}
```

- - -

**Adapter Layer:** filesystem/AWS/process boundary mechanics.

### Requirement: Temporary Key Staging [REMOTE-ADAPTER-STAGE]
WHEN `connect` or `cp` begins remote-access setup, THE devbox adapter SHALL follow the documented `ssh-over-ssm` style workflow by staging a temporary SSH public key through AWS SSM before starting the SSH transport session.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`

#### Scenario: Staging Completes Before Transport [REMOTE-STAGE-SUCCESS]
WHEN temporary SSH key staging succeeds, THE devbox adapter SHALL wait for staging completion before starting SSH or SCP transport.

**Postcondition:** Remote transport starts only after staged authorization is available.

##### Evidence
- Implementation: [remote-access.ts:106 resolveRemoteAccessPreconditions()](/src/cli/remote-access.ts#L106), [ssh-cli.ts:313 stageTemporarySshKey()](/src/adapters/ssh-cli.ts#L313)
- Test: [ssh-cli.contract.test.ts:83 stages temporary key via SSM with bounded remote cleanup command](/test/contract/ssh-cli.contract.test.ts#L83)
- Test (integration): [remote-access.integration.test.ts:76 continues to staged transport setup when instance is running and SSM-ready](/test/integration/remote-access.integration.test.ts#L76)

#### Scenario: Staging Failure Stops Transport [REMOTE-STAGE-FAIL]
IF temporary SSH key staging fails, THEN THE devbox adapter SHALL fail with `TransportError` and SHALL NOT start SSH or SCP transport.

**Postcondition:** No partially initialized remote transport session is attempted.

##### Evidence
- Implementation: [remote-access.ts:106 resolveRemoteAccessPreconditions()](/src/cli/remote-access.ts#L106), [ssh-cli.ts:313 stageTemporarySshKey()](/src/adapters/ssh-cli.ts#L313)
- Test: [ssh-cli.contract.test.ts:101 reports transport error when key staging command fails](/test/contract/ssh-cli.contract.test.ts#L101)

#### Requirement model

```alloy
// --- Key staging: staging must complete before transport ---
// KeyStore events are integrated into staging_success
// (agent key vs temp key is determined nondeterministically at staging time)

pred staging_success [a : Alias] {
  a in current
  Session.phase = Staging
  // Effect: key staged, advance to transport
  Session.phase' = Transporting
  Session.keyStaged' = True
  Session.transportStarted' = False  // not yet started, just ready
  Session.cleanupScheduled' = Session.cleanupScheduled
  Session.lastConnectUpdated' = Session.lastConnectUpdated
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = CommandResult.outcome
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore: nondeterministic choice models agent availability
  (KeyStore.source' = AgentKey and KeyStore.tempFilesExist' = False) or
  (KeyStore.source' = TempKey and KeyStore.tempFilesExist' = True)
}

pred staging_failure [a : Alias] {
  a in current
  Session.phase = Staging
  // Effect: TransportError, no transport started
  Session.phase' = Failed
  Session.keyStaged' = False
  Session.transportStarted' = False
  Session.cleanupScheduled' = False
  Session.lastConnectUpdated' = False
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  CommandResult.outcome' = TransportError
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  // CpState frame
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
  // KeyStore frame (staging failed, no key established)
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
}

// Safety: transport never starts without staged key
assert transport_requires_staged_key {
  always (Session.phase = Transporting implies Session.keyStaged = True)
}

// Safety: staging failure blocks all transport
assert staging_failure_blocks_transport {
  always (Session.keyStaged = False implies Session.transportStarted = False)
}
```

### Requirement: Temporary Key Cleanup [REMOTE-ADAPTER-CLEANUP]
WHEN temporary SSH key staging is used, THE devbox adapter SHALL bound the lifetime of the remote authorized-key entry to 5 minutes and SHALL attempt best-effort cleanup on local failure paths.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`

#### Scenario: Cleanup Scheduled Or Performed [REMOTE-CLEANUP-SUCCESS]
WHEN remote access is staged successfully, THE devbox adapter SHALL remove or schedule removal of the temporary key material within the 5-minute bound.

**Postcondition:** Temporary authorization does not remain unmanaged indefinitely.

##### Evidence
- Implementation: [ssh-cli.ts:313 stageTemporarySshKey()](/src/adapters/ssh-cli.ts#L313), [connect.ts:80 runConnectCommand()](/src/cli/commands/connect.ts#L80), [cp.ts:94 runCpCommand()](/src/cli/commands/cp.ts#L94), [ssh-cli.ts:567 cleanupLocalTempKeys()](/src/adapters/ssh-cli.ts#L567)
- Test: [ssh-cli.contract.test.ts:118 cleans up generated local temp keys](/test/contract/ssh-cli.contract.test.ts#L118)
- Test (integration): [remote-commands.integration.test.ts:76 connect updates lastConnectAt after a successful session](/test/integration/remote-commands.integration.test.ts#L76), [remote-commands.integration.test.ts:134 connect returns transport error details on local session failure and still cleans up](/test/integration/remote-commands.integration.test.ts#L134), [remote-commands.integration.test.ts:168 cp uploads to temp, finalizes, and updates lastConnectAt](/test/integration/remote-commands.integration.test.ts#L168)

#### Scenario: Cleanup Failure Reported [REMOTE-CLEANUP-FAIL]
IF best-effort cleanup cannot be completed during a local failure path, THEN THE devbox adapter SHALL still fail the command with transport failure details while preserving the bounded cleanup intent.

**Postcondition:** The caller receives explicit transport failure information instead of silent cleanup loss.

##### Evidence
- Implementation: [connect.ts:126 runConnectCommand()](/src/cli/commands/connect.ts#L126), [cp.ts:170 runCpCommand()](/src/cli/commands/cp.ts#L170), [ssh-cli.ts:313 stageTemporarySshKey()](/src/adapters/ssh-cli.ts#L313)
- Test (integration): [remote-commands.integration.test.ts:152 connect preserves transport error when cleanup also fails](/test/integration/remote-commands.integration.test.ts#L152)

#### Requirement model

```alloy
// --- Temporary key cleanup: bounded lifetime ---

pred cleanup_performed {
  Session.phase in (Done + Failed)
  Session.keyStaged = True
  // Cleanup scheduled on any path that staged a key
  Session.cleanupScheduled = True
}

// Safety: cleanup is always scheduled when staging succeeded
assert cleanup_always_scheduled_after_staging {
  always (
    (Session.keyStaged = True and Session.phase' in (Done + Failed))
      implies Session.cleanupScheduled' = True)
}

// Liveness with explicit fairness premise
pred session_progress_fairness {
  always (
    Session.phase in (Idle + WaitingSSM + Staging + Transporting)
      implies eventually Session.phase in (Done + Failed))
}

assert staged_keys_eventually_cleaned {
  session_progress_fairness implies
    always (Session.keyStaged = True implies eventually Session.cleanupScheduled = True)
}
```

### Requirement: Temporary Key Storage [REMOTE-ADAPTER-KEYSTORE]
WHEN `connect` or `cp` requires a temporary SSH keypair, THE devbox adapter SHALL store the private key at `~/.ssh/ssm-ssh-tmp` and the public key at `~/.ssh/ssm-ssh-tmp.pub`, generated with `ssh-keygen -t rsa -N '' -f ~/.ssh/ssm-ssh-tmp -C ssh-over-ssm`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Agent Key Available [REMOTE-KEY-AGENT]
WHEN `ssh-add -l` reports available keys, THE devbox adapter SHALL use the first key from the local SSH agent instead of generating a temporary keypair.

**Postcondition:** No temporary key files are created on disk.

##### Evidence
- Implementation: [ssh-cli.ts:224 ensureSshKeyMaterial()](/src/adapters/ssh-cli.ts#L224)
- Test: [ssh-cli.contract.test.ts:49 prefers ssh-agent key material when available](/test/contract/ssh-cli.contract.test.ts#L49)

#### Scenario: Temporary Key Generated And Cleaned [REMOTE-KEY-TEMP]
WHEN no agent key is available, THE devbox adapter SHALL generate a temporary keypair at `~/.ssh/ssm-ssh-tmp` and remove both files on process exit.

**Postcondition:** Temporary key files are removed when the process exits normally or via trapped signals.

##### Evidence
- Implementation: [ssh-cli.ts:224 ensureSshKeyMaterial()](/src/adapters/ssh-cli.ts#L224), [ssh-cli.ts:567 cleanupLocalTempKeys()](/src/adapters/ssh-cli.ts#L567)
- Test: [ssh-cli.contract.test.ts:65 falls back to generated temporary key material when ssh-agent is unavailable](/test/contract/ssh-cli.contract.test.ts#L65), [ssh-cli.contract.test.ts:118 cleans up generated local temp keys](/test/contract/ssh-cli.contract.test.ts#L118)

#### Scenario: Remote Key Removal Bounded [REMOTE-KEY-REMOTE-CLEANUP]
WHEN a temporary SSH public key is staged on the remote instance, THE devbox adapter SHALL schedule a background removal job on the remote host that removes the key from `authorized_keys` after 15 seconds.

**Postcondition:** The remote authorized-key entry is removed within 15 seconds regardless of local process behavior.

##### Evidence
- Implementation: [ssh-cli.ts:313 stageTemporarySshKey()](/src/adapters/ssh-cli.ts#L313)
- Test: [ssh-cli.contract.test.ts:83 stages temporary key via SSM with bounded remote cleanup command](/test/contract/ssh-cli.contract.test.ts#L83)

#### Requirement model

```alloy
// --- Key storage: agent preference and temp-key lifecycle ---

pred remove_temp_files_event {
  // Guard: session complete, temp files exist
  Session.phase in (Done + Failed)
  KeyStore.source = TempKey
  KeyStore.tempFilesExist = True
  // Effect: remove temp files
  KeyStore.tempFilesExist' = False
  KeyStore.source' = KeyStore.source
  // Frame: session state unchanged
  Session.phase' = Session.phase
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  Session.keyStaged' = Session.keyStaged
  Session.transportStarted' = Session.transportStarted
  Session.cleanupScheduled' = Session.cleanupScheduled
  Session.lastConnectUpdated' = Session.lastConnectUpdated
  CommandResult.outcome' = CommandResult.outcome
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
}

// Safety: agent key never creates temp files
assert agent_key_no_temp_files {
  always (KeyStore.source = AgentKey implies KeyStore.tempFilesExist = False)
}

// Fairness covers entire path: transport completes AND cleanup fires
pred temp_cleanup_fairness {
  // Transport must eventually complete when in progress
  always (
    (Session.phase = Transporting and Session.keyStaged = True)
      implies eventually (Session.phase in (Done + Failed)))
  // Cleanup fires when session is complete and temp files exist
  always (
    (KeyStore.tempFilesExist = True and Session.phase in (Done + Failed))
      implies eventually remove_temp_files_event)
}

assert temp_files_eventually_removed {
  temp_cleanup_fairness implies
    always (KeyStore.tempFilesExist = True implies eventually KeyStore.tempFilesExist = False)
}
```

### State machine and invariant checks

```alloy
// --- Transition system ---

pred stutter {
  Session.phase' = Session.phase
  Session.ssmTicksRemaining' = Session.ssmTicksRemaining
  Session.keyStaged' = Session.keyStaged
  Session.transportStarted' = Session.transportStarted
  Session.cleanupScheduled' = Session.cleanupScheduled
  Session.lastConnectUpdated' = Session.lastConnectUpdated
  CommandResult.outcome' = CommandResult.outcome
  CommandResult.exitCode' = CommandResult.exitCode
  current' = current
  all i : Instance | i.running' = i.running and i.ssmReady' = i.ssmReady
  KeyStore.source' = KeyStore.source
  KeyStore.tempFilesExist' = KeyStore.tempFilesExist
  CpState.cpPhase' = CpState.cpPhase
  CpState.uploadedToTemp' = CpState.uploadedToTemp
  CpState.finalizedAtDest' = CpState.finalizedAtDest
}

pred init {
  Session.phase = Idle
  Session.ssmTicksRemaining = 24
  Session.keyStaged = False
  Session.transportStarted = False
  Session.cleanupScheduled = False
  Session.lastConnectUpdated = False
  no CommandResult.outcome
  no CommandResult.exitCode
  KeyStore.source = AgentKey
  KeyStore.tempFilesExist = False
  CpState.cpPhase = CpUploading
  CpState.uploadedToTemp = False
  CpState.finalizedAtDest = False
  all i : Instance | i.running = True and i.ssmReady = False
}

fact transitions {
  init and always (
    // Precondition checks
    (some a : Alias | check_running[a] or rejected_not_running[a])
    or (some a : Alias | ssm_poll_tick[a] or ssm_timeout[a])
    // Key staging
    or (some a : Alias | staging_success[a] or staging_failure[a])
    // Transport
    or (some a : Alias | cp_upload_done[a])
    or (some a : Alias | connect_success[a] or connect_consistency_error[a])
    or (some a : Alias | cp_success[a] or cp_consistency_error[a])
    // Path rejection (issue 21: only fires from Idle)
    or (some p : RemotePath | path_rejected[p])
    // No current box
    or remote_rejected_no_current
    // Key cleanup (issue 25: connected to transitions)
    or remove_temp_files_event
    // Stutter
    or stutter
  )
}

// --- Commands ---

run show_remote_access {} for 2 Alias, 2 Instance, 2 SshUser, 1 RemotePath, 8 Int, 5 steps

run scenario_connect_success {
  eventually (Session.phase = Done and CommandResult.outcome = Success)
} for 1 Alias, 1 Instance, 1 SshUser, 0 RemotePath, 8 Int, 8 steps

run scenario_cp_success {
  eventually (CpState.cpPhase = CpDone and CpState.finalizedAtDest = True)
} for 1 Alias, 1 Instance, 1 SshUser, 1 RemotePath, 8 Int, 12 steps

check no_transport_before_ssm_ready for 2 Alias, 2 Instance, 2 SshUser, 1 RemotePath, 8 Int, 15 steps expect 0
check transport_requires_staged_key for 2 Alias, 2 Instance, 2 SshUser, 1 RemotePath, 8 Int, 15 steps expect 0
check last_connect_requires_both_successes for 2 Alias, 2 Instance, 2 SshUser, 1 RemotePath, 8 Int, 15 steps expect 0
check unsafe_path_never_transported for 2 Alias, 2 Instance, 2 SshUser, 2 RemotePath, 8 Int, 10 steps expect 0
check no_staging_without_current for 2 Alias, 2 Instance, 2 SshUser, 1 RemotePath, 8 Int, 10 steps expect 0
check cleanup_always_scheduled_after_staging for 2 Alias, 2 Instance, 2 SshUser, 1 RemotePath, 8 Int, 15 steps expect 0
check cp_no_partial_destination for 2 Alias, 2 Instance, 2 SshUser, 1 RemotePath, 8 Int, 10 steps expect 0
check no_artificial_size_limit for 1 Alias, 1 Instance, 1 SshUser, 1 RemotePath, 8 Int, 10 steps expect 0
check exit_code_propagated for 1 Alias, 1 Instance, 1 SshUser, 0 RemotePath, 8 Int, 10 steps expect 0
check agent_key_no_temp_files for 1 Alias, 1 Instance, 1 SshUser, 0 RemotePath, 8 Int, 10 steps expect 0
check staged_keys_eventually_cleaned for 1 Alias, 1 Instance, 1 SshUser, 0 RemotePath, 8 Int, 20 steps
check temp_files_eventually_removed for 1 Alias, 1 Instance, 1 SshUser, 0 RemotePath, 8 Int, 15 steps
check ssm_polling_terminates for 1 Alias, 1 Instance, 1 SshUser, 0 RemotePath, 7 Int, 15 steps
```
