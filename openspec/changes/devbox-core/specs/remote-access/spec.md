## ADDED Requirements

### Requirement: CLI Remote Access Commands [REMOTE-CLI-CMDS]
THE devbox CLI SHALL provide `connect` and `cp <local> <remote>` commands, each supporting an invocation-time `--ssh-user <user>` override.

**References:**
- `proposal.md#Scope`
- `proposal.md#Capabilities`

#### Scenario: Runtime SSH User Override [REMOTE-CLI-SSHUSER]
WHEN the user invokes `connect` or `cp` with `--ssh-user <user>`, THE devbox CLI SHALL pass that override into SSH-user resolution for the command.

**Postcondition:** The invocation override becomes the highest-precedence SSH-user input.

#### Scenario: Missing Current Box Rejected [REMOTE-CLI-FAIL]
IF the user invokes `connect` or `cp` and no current box is selected, THEN THE devbox CLI SHALL fail before any remote-access setup begins.

**Postcondition:** No staging, transport, or `lastConnectAt` update occurs.

### Requirement: Remote Access Preconditions [REMOTE-DOMAIN-PRECOND]
WHILE `connect` or `cp` is running, THE devbox domain SHALL require the current instance to be `running`, require the instance to become SSM-ready within the readiness timeout, and require all documented local dependencies for the requested command.

**References:**
- `proposal.md#Assumptions and Dependencies`
- `proposal.md#Failure Modes`

#### Scenario: Running And Ready Continues [REMOTE-PRECOND-READY]
WHILE the current instance is `running` and becomes SSM-ready within 2 minutes, THE devbox domain SHALL allow remote-access transport setup to proceed.

**Postcondition:** The command may start the staging and transport flow.

#### Scenario: Non Running Or Unready Rejected [REMOTE-PRECOND-FAIL]
IF the current instance is not `running` or does not become SSM-ready within 2 minutes, THEN THE devbox domain SHALL fail with `InstanceStateError` or `TimeoutError` before SSH transport begins.

**Postcondition:** No SSH or SCP session is started.

### Requirement: SSH User Resolution [REMOTE-DOMAIN-SSHUSER]
WHEN `connect` or `cp` requires an SSH user, THE devbox domain SHALL resolve it using invocation override, then per-box `sshUser`, then `defaults.sshUser`.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Defaults SSH User Used [REMOTE-SSHUSER-DEFAULT]
WHEN no invocation override or per-box override is present and `defaults.sshUser` is configured, THE devbox domain SHALL use `defaults.sshUser` for remote access.

**Postcondition:** The remote-access flow has a single resolved SSH user.

#### Scenario: Unresolvable SSH User Rejected [REMOTE-SSHUSER-FAIL]
IF no SSH user can be resolved from invocation override, per-box override, or `defaults.sshUser`, THEN THE devbox domain SHALL fail before temporary key staging begins.

**Postcondition:** No remote access is attempted with an implicit or guessed SSH user.

### Requirement: Connect Session Contract [REMOTE-DOMAIN-CONNECT]
WHEN `connect` succeeds, THE devbox domain SHALL establish an SSM-backed SSH session to the current instance and SHALL update `lastConnectAt` only after session startup succeeds and the subsequent local config commit succeeds.

**References:**
- `proposal.md#Scope`
- `proposal.md#Failure Modes`

#### Scenario: Connect Success Updates Timestamp [REMOTE-CONNECT-SUCCESS]
WHEN `connect` completes session startup successfully and the local config commit succeeds, THE devbox domain SHALL update `lastConnectAt` for the current tracked box.

**Postcondition:** The tracked box records the last successful remote-access time.

#### Scenario: Connect External Success Local Failure [REMOTE-CONNECT-CONSISTENCY]
IF `connect` succeeds in starting the remote session but the subsequent config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that `lastConnectAt` may be stale locally.

**Postcondition:** Divergence is reported explicitly after external success.

### Requirement: Copy Transport Contract [REMOTE-DOMAIN-CP]
WHEN `cp <local> <remote>` succeeds, THE devbox domain SHALL upload exactly one regular local file to a temporary path in the destination directory and finalize the destination with an atomic remote move.

**References:**
- `proposal.md#Scope`
- `proposal.md#Failure Modes`

#### Scenario: Copy Success Finalizes Destination [REMOTE-CP-SUCCESS]
WHEN `cp` validates the local file and remote path, completes upload to a temporary remote path, and completes finalization successfully, THE devbox domain SHALL report success and update `lastConnectAt` only after the local config commit succeeds.

**Postcondition:** The final destination path contains the uploaded file and no partial final-path write occurred.

#### Scenario: Copy Final Success Local Failure [REMOTE-CP-CONSISTENCY]
IF `cp` completes remote transfer and finalization successfully but the subsequent local config commit fails, THEN THE devbox domain SHALL fail with `ConsistencyError` and report that the remote file update succeeded while `lastConnectAt` may be stale locally.

**Postcondition:** The command reports cross-system divergence explicitly.

### Requirement: Remote Path Validation [REMOTE-DOMAIN-PATH]
WHEN `cp` receives a remote path, THE devbox domain SHALL require the remote path to be non-empty after trimming and SHALL reject ASCII control characters and null bytes before any transport begins.

**References:**
- `proposal.md#Failure Modes`
- `proposal.md#Quality Attributes`

#### Scenario: Safe Remote Path Accepted [REMOTE-PATH-ACCEPT]
WHEN the remote path is non-empty after trimming and contains no ASCII control characters or null bytes, THE devbox domain SHALL allow transport preparation to continue.

**Postcondition:** The path is eligible for conservative POSIX quoting and transmission.

#### Scenario: Unsafe Remote Path Rejected [REMOTE-PATH-FAIL]
IF the remote path contains an ASCII control character or null byte, THEN THE devbox domain SHALL fail with `ValidationError` before any SSH, SCP, or AWS transport command is executed.

**Postcondition:** The unsafe path never reaches a remote shell.

### Requirement: Temporary Key Staging [REMOTE-ADAPTER-STAGE]
WHEN `connect` or `cp` begins remote-access setup, THE devbox adapter SHALL follow the documented `ssh-over-ssm` style workflow by staging a temporary SSH public key through AWS SSM before starting the SSH transport session.

**References:**
- `proposal.md#Scope`
- `proposal.md#Quality Attributes`

#### Scenario: Staging Completes Before Transport [REMOTE-STAGE-SUCCESS]
WHEN temporary SSH key staging succeeds, THE devbox adapter SHALL wait for staging completion before starting SSH or SCP transport.

**Postcondition:** Remote transport starts only after staged authorization is available.

#### Scenario: Staging Failure Stops Transport [REMOTE-STAGE-FAIL]
IF temporary SSH key staging fails, THEN THE devbox adapter SHALL fail with `TransportError` and SHALL NOT start SSH or SCP transport.

**Postcondition:** No partially initialized remote transport session is attempted.

### Requirement: Temporary Key Cleanup [REMOTE-ADAPTER-CLEANUP]
WHEN temporary SSH key staging is used, THE devbox adapter SHALL bound the lifetime of the remote authorized-key entry to 5 minutes and SHALL attempt best-effort cleanup on local failure paths.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Cleanup Scheduled Or Performed [REMOTE-CLEANUP-SUCCESS]
WHEN remote access is staged successfully, THE devbox adapter SHALL remove or schedule removal of the temporary key material within the 5-minute bound.

**Postcondition:** Temporary authorization does not remain unmanaged indefinitely.

#### Scenario: Cleanup Failure Reported [REMOTE-CLEANUP-FAIL]
IF best-effort cleanup cannot be completed during a local failure path, THEN THE devbox adapter SHALL still fail the command with transport failure details while preserving the bounded cleanup intent.

**Postcondition:** The caller receives explicit transport failure information instead of silent cleanup loss.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
