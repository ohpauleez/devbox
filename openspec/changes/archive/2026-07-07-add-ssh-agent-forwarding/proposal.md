## Motivation

`connect` opens an interactive SSH session to a devbox instance over an SSM-tunneled connection. Once on the remote host, users routinely need to authenticate onward — `git pull`/`git push` against a private repo, `scp` to a third host, or `ssh` into another box in the fleet. Today the only identity material available on the remote host is whatever the connect flow put there: either a short-lived generated keypair staged for the SSM hop, or nothing at all when the user's local `ssh-agent` was used to authenticate the hop itself. Neither path gives the remote host access to the user's actual signing capability, so onward authentication either fails or forces users to copy private key material onto the devbox — a practice this project's own `TemporaryKeyStorage`/`TemporaryKeyCleanup` requirements exist specifically to avoid on the connect path.

SSH agent forwarding solves this without ever placing private key material on the remote host: the remote host's `ssh`/`git`/`scp` processes talk back to the user's local `ssh-agent` over a forwarded socket, so the user's identity is usable remotely while the private key itself never leaves the local machine.

## Scope

### In Scope
- An opt-in flag on the `connect` command that requests SSH agent forwarding for the interactive session.
- Preconditions that ensure forwarding is only attempted when a local signing agent is actually available and useful, with a clear, actionable failure when it isn't.
- Explicit statement that agent forwarding is independent of, and does not change, how the SSM-tunneled hop itself is authenticated (generated temporary key vs. local agent key selection).

### Out of Scope
- The `cp` command. `cp` is a single-shot, non-interactive file transfer; nothing executes on the remote host during a copy that could make use of a forwarded agent, so extending forwarding to `cp` adds attack surface (a compromised remote host could request signatures from the forwarded agent) with no corresponding benefit.
- Any change to which key authenticates the SSM-tunneled SSH connection itself (`REMOTE-ADAPTER-KEYSTORE` behavior is unchanged).
- Persisting a forwarding preference in box or global config; this change covers invocation-time opt-in only.
- Support for forwarding a specific subset of agent identities (e.g., `ssh -A` semantics only, not fine-grained identity restriction).

## Context

### Background
The existing `remote-access` capability already models three layers for `connect`/`cp`: CLI (command surface and flags), Domain (preconditions, SSH-user resolution, session lifecycle), and Adapter (the actual `ssh`/`scp` invocation, temporary key staging and cleanup). Local `ssh-agent` involvement today is limited to `REMOTE-ADAPTER-KEYSTORE`, which prefers an already-running local agent key over generating a temporary keypair for authenticating the hop — that requirement is about how the *local* side authenticates outward, not about giving the *remote* side any signing capability.

### Affected Systems and Stakeholders
- The `connect` CLI command and its option parsing.
- The SSH adapter that assembles `ssh` invocation arguments and starts the interactive session.
- Developers using `connect` who need to authenticate onward from the devbox to other systems (git hosts, other instances).

### Assumptions and Dependencies
- A local `ssh-agent` (or equivalent, e.g. macOS Keychain-backed agent) may or may not be running at invocation time; its presence and identity count cannot be assumed.
- The remote host's `sshd` must permit agent forwarding (`AllowAgentForwarding`, default yes on stock OpenSSH); this change cannot control remote host configuration and treats a remote-side refusal as an external failure, not a defect in this capability.
- No new external dependency is introduced; forwarding is a standard OpenSSH client capability (`-A` / `ForwardAgent`).

### Constraints
- Must not change default `connect` behavior when the new flag is omitted (backward compatible, opt-in only).
- Must not weaken the existing temporary-key staging/cleanup guarantees for the SSM hop.
- Security-sensitive: forwarding must never be silently enabled, and must never proceed silently as a no-op when it cannot actually provide remote signing capability.

### References
- `openspec/specs/remote-access/spec.md` — current CLI/Domain/Adapter requirements for `connect`/`cp`.
- `openspec/changes/archive/2026-06-05-devbox-core/` — original `remote-access` capability proposal/design.

## Domain Model

- **Connection Request**: a user's invocation of `connect`, carrying invocation-time options (existing: SSH-user override; new: an agent-forwarding request).
- **Local Signing Agent**: an external actor reachable from the local machine (e.g. via `SSH_AUTH_SOCK`) that holds zero or more **Identities** and can produce signatures without exposing private key material.
- **Agent Forwarding Preference**: a boolean intent attached to a Connection Request, independent from the existing key-selection concern (`REMOTE-ADAPTER-KEYSTORE`) that governs how the SSM hop itself is authenticated.
- **Connection Session**: the existing entity representing an established interactive SSH session; gains an attribute describing whether agent forwarding is active for that session.

Relationship: a Connection Request references at most one Local Signing Agent (the ambient one on the operator's machine) and produces a Connection Session whose forwarding state is determined jointly by the Agent Forwarding Preference and the availability/identity count of the Local Signing Agent at request time.

## Preconditions, Postconditions, and Invariants

- **Precondition**: To honor an Agent Forwarding Preference of "enabled," a Local Signing Agent must be reachable and expose at least one Identity at the time `connect` is invoked.
- **Postcondition**: When forwarding is requested and its precondition holds, the resulting Connection Session is established such that processes on the remote host can request signatures from the Local Signing Agent.
- **Postcondition**: When forwarding is not requested, the resulting Connection Session behaves exactly as it does today — no observable change.
- **Invariant**: Agent forwarding is never enabled unless explicitly requested for that invocation (opt-in, not persisted, not inferred).
- **Invariant**: The Agent Forwarding Preference has no effect on, and is not affected by, which key authenticates the SSM-tunneled hop (`REMOTE-ADAPTER-KEYSTORE` behavior is unchanged).
- **Invariant**: `connect` never reports success while silently failing to honor an explicit forwarding request — if the precondition cannot be met, the command fails clearly rather than connecting without forwarding.

## Failure Modes

- **Forwarding requested with no local agent reachable**: The user asks for agent forwarding, but no `ssh-agent` (or equivalent) is reachable from the local machine.
  - **Rationale**: Silently connecting without forwarding would leave the user believing onward authentication will work on the remote host when it will not, discovered only after they attempt to `git push` or `ssh` onward mid-session — a confusing, hard-to-diagnose failure far from its cause.
- **Forwarding requested with a reachable agent that holds zero identities**: The agent process exists, but no key is loaded (`ssh-add -l` reports none).
  - **Rationale**: OpenSSH's own `-A` succeeds in this case but forwarding is functionally useless — the same misleading "it looks connected, why can't I auth onward" failure mode applies, so this must be surfaced the same way as no-agent-reachable rather than passed through silently.
- **Remote host rejects or ignores agent forwarding**: The devbox instance's `sshd` has `AllowAgentForwarding no`, or forwarding is otherwise unavailable remotely.
  - **Rationale**: This is outside devbox's control (instance-side configuration), but the product should not claim forwarding succeeded when the remote host silently drops it; the session should still connect (this is not a reason to block the connection), since failing the whole connection over a remote policy the user cannot change from `connect` would be disproportionate.

## Quality Attributes

- **Security**:
  - **Target/Threshold**: Zero change to default `connect` behavior when the forwarding flag is not passed; forwarding is never enabled implicitly.
  - **Influence**: Keeps the blast radius of a compromised or untrusted devbox instance unchanged for the common case, and makes the opt-in explicit and auditable (visible in the invocation).
- **Usability**:
  - **Target/Threshold**: A user who requests forwarding without a usable local agent gets an actionable error before any SSH session is attempted, not a silent degradation.
  - **Influence**: Prevents the "it connected but onward auth doesn't work" failure mode from reaching users mid-session.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `remote-access`: adds an opt-in SSH agent forwarding option to the `connect` command's interactive session, including the CLI flag, a domain-level precondition on local agent availability, and adapter-level behavior for enabling agent forwarding on the underlying `ssh` invocation. The `cp` command and existing key-selection behavior (`REMOTE-ADAPTER-KEYSTORE`) are unaffected.
