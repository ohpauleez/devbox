<!-- EARS Pattern Reference:
     Ubiquitous:        THE <system> SHALL <response>.
     State-driven:      WHILE <precondition>, THE <system> SHALL <response>.
     Event-driven:      WHEN <trigger>, THE <system> SHALL <response>.
     Unwanted-behavior: IF <trigger>, THEN THE <system> SHALL <response>.
     Complex:           WHILE <precondition>, WHEN <trigger>, THE <system> SHALL <response>.
     Optional:          WHERE <feature is included>, THE <system> SHALL <response>. -->

## ADDED Requirements

**CLI Layer:** command surface, parsing, output, and composition of domain+adapters.

### Requirement: CLI Agent Forwarding Flag [REMOTE-CLI-FORWARDAGENT]
WHERE the user invokes `connect` with `--forward-agent`, THE devbox CLI SHALL treat the invocation as an SSH agent-forwarding request and pass it into remote-access precondition resolution and SSH session start.

**References:**
- `openspec/changes/add-ssh-agent-forwarding/proposal.md#Scope`
- `openspec/changes/add-ssh-agent-forwarding/proposal.md#Domain Model`
- `openspec/changes/add-ssh-agent-forwarding/design.md#Component Design`

#### Scenario: Forward Agent Flag Parsed In Either Order [REMOTE-FWDAGENT-PARSE]
WHEN the user invokes `connect --forward-agent` together with `--ssh-user <user>` in either order, THE devbox CLI SHALL parse both options and reject only remaining unconsumed arguments.

**Postcondition:** The agent-forwarding request and the resolved SSH-user override are both available to the command.

#### Scenario: Forward Agent Rejected On Copy [REMOTE-FWDAGENT-CPREJECT]
IF the user invokes `cp` with `--forward-agent`, THEN THE devbox CLI SHALL reject the invocation as invalid before any remote-access setup begins.

**Postcondition:** No staging, transport, or config update occurs.

- - -

**Domain Layer:** deterministic business rules and state machine.

### Requirement: Agent Forwarding Precondition [REMOTE-DOMAIN-FORWARDAGENT]
WHILE an agent-forwarding request accompanies `connect`, THE devbox domain SHALL require that the resolved SSH key material originated from a local agent before describing the instance, waiting for SSM readiness, or staging any key.

**References:**
- `openspec/changes/add-ssh-agent-forwarding/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/add-ssh-agent-forwarding/proposal.md#Failure Modes`
- `openspec/changes/add-ssh-agent-forwarding/design.md#Architecture Decisions`

#### Scenario: Forwarding With Agent Key Continues [REMOTE-FWDAGENT-READY]
WHEN an agent-forwarding request is present and the resolved key material's source is the local agent, THE devbox domain SHALL allow remote-access precondition resolution to continue to instance verification.

**Postcondition:** Instance description, SSM readiness waiting, and key staging may proceed.

#### Scenario: Forwarding Without Agent Key Rejected [REMOTE-FWDAGENT-FAIL]
IF an agent-forwarding request is present and the resolved key material was generated locally rather than sourced from an agent, THEN THE devbox domain SHALL fail with `ValidationError` before describing the instance, waiting for SSM readiness, or staging any key.

**Postcondition:** No AWS or SSM call occurs; no key is staged; no SSH session starts.

- - -

**Adapter Layer:** SSH/SCP process invocation.

### Requirement: Interactive Session Agent Forwarding [REMOTE-ADAPTER-FORWARDAGENT]
WHERE an agent-forwarding request has satisfied its precondition, THE devbox SSH adapter SHALL enable SSH agent forwarding on the interactive `connect` session only, and SHALL NOT enable it on `cp`'s upload or finalize transport.

**References:**
- `openspec/changes/add-ssh-agent-forwarding/proposal.md#Scope`
- `openspec/changes/add-ssh-agent-forwarding/proposal.md#Failure Modes`
- `openspec/changes/add-ssh-agent-forwarding/design.md#Architecture Decisions`
- `openspec/changes/add-ssh-agent-forwarding/design.md#Component Design`

#### Scenario: Interactive Session Forwards Agent [REMOTE-FWDAGENT-SESSION]
WHEN the interactive SSH session is started with an honored agent-forwarding request, THE devbox SSH adapter SHALL include the agent-forwarding option in the spawned `ssh` invocation.

**Postcondition:** The remote host's `sshd`, if configured to allow it, exposes the forwarded agent socket to the session.

#### Scenario: Copy Transport Never Forwards Agent [REMOTE-FWDAGENT-CPSAFE]
WHEN `cp` uploads or finalizes a file, THE devbox SSH adapter SHALL NOT include the agent-forwarding option in the spawned `scp` or `ssh` invocation.

**Postcondition:** `cp`'s transport arguments are unchanged from before this capability existed.

#### Scenario: Remote Rejection Does Not Fail Connection [REMOTE-FWDAGENT-TOLERATE]
IF the remote host's `sshd` refuses or ignores agent forwarding, THEN THE devbox SSH adapter SHALL still allow the interactive session to proceed without treating the refusal as a connection failure.

**Postcondition:** `connect`'s exit code reflects the SSH session's own outcome, not the forwarding outcome.
