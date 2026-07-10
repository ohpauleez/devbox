## Context

### Current State
`connect` resolves a shared precondition chain (`resolveRemoteAccessPreconditions` in `src/cli/remote-access.ts`) before starting an interactive SSH session: load config → resolve current box → resolve SSH user → describe instance (AWS) → verify running → wait for SSM online → ensure local SSH key material (`ensureSshKeyMaterial` in `src/adapters/ssh-cli.ts`) → stage a public key on the remote host via SSM (`stageTemporarySshKey`). `ensureSshKeyMaterial` already runs `ssh-add -l` to prefer a running local `ssh-agent`'s key over generating a temporary keypair; its `StagedKey.fromAgent` field is `true` exactly when that check succeeded (an agent is reachable with at least one loaded identity). `startInteractiveSsh` then spawns `ssh` with `commonSshArgs()` — a small fixed set of `-o ProxyCommand=...`, `StrictHostKeyChecking`, `UserKnownHostsFile`, and (when not using the agent) `-i <path> -o IdentitiesOnly=yes`. `commonSshArgs()` is shared by `startInteractiveSsh`, `uploadFileOverScp`, and `finalizeRemoteFile` — the latter two back the `cp` command.

### Constraints and Architecture Drivers
- Must be additive and backward compatible: omitting the new flag must produce byte-identical behavior to today.
- Must not touch `cp`'s code paths (`uploadFileOverScp`, `finalizeRemoteFile`) — both use `commonSshArgs()`, so any change there risks `cp` regressions.
- Must not weaken or duplicate `REMOTE-ADAPTER-KEYSTORE` semantics (which key authenticates the SSM hop is unaffected by this change).
- Must fail before AWS/SSM work begins when the forwarding precondition cannot be met (mirrors the existing `REMOTE-CLI-FAIL` precedent: reject before any remote-access setup).

## Goals
- Let `connect` forward the local `ssh-agent` to the remote host so onward authentication (git, ssh, scp from the devbox) works without ever placing private key material on the instance.
- Fail fast and clearly when forwarding is requested but no usable local agent exists.

### Non-Goals
- Changing `cp` behavior in any way.
- Changing which key authenticates the SSM-tunneled hop.
- Persisting a forwarding default in box/global config.

## Architecture Decisions

### Decision: Gate forwarding on `ensureSshKeyMaterial`'s existing agent signal, not a second `ssh-add` call

- **Context and Objective:** Agent forwarding is only meaningful if a local agent with ≥1 identity exists. `ensureSshKeyMaterial` already determines this exact fact (`fromAgent`) as part of choosing which key authenticates the SSM hop, and today it *always* prefers the agent when one is available — so `fromAgent === true` is already a precise, up-to-date proxy for "an agent with a usable identity exists."
- **Quality Attribute Tactics and Key Results:** Correctness (single source of truth, no risk of two `ssh-add -l` calls disagreeing) and performance (avoids a redundant subprocess spawn on every `connect` invocation).
- **Options Considered:**
  - A: Add an independent `checkAgentForwardingAvailable()` helper that re-runs `ssh-add -l`. Simple to isolate, but duplicates the exact check `ensureSshKeyMaterial` already performs, and opens a (tiny, practically irrelevant) window for the two checks to disagree if agent state changes mid-invocation.
  - B: Reuse `StagedKey.fromAgent` from the existing `ensureSshKeyMaterial` call. No new subprocess, single source of truth, but requires moving that call earlier in the precondition chain (see next decision).
- **Decision:** Option B.
- **Consequences:** Forwarding eligibility is defined in terms of an already-existing domain fact, so `REMOTE-ADAPTER-KEYSTORE` needs no behavioral change — this change only reads its result earlier and adds a new gate on it. Positive: no duplicate local process calls. Negative: `resolveRemoteAccessPreconditions`'s step order changes (see below), so the base spec's step-numbered Evidence/Alloy model needs updating in the specs artifact.

### Decision: Reorder `resolveRemoteAccessPreconditions` so key-material resolution happens before AWS calls

- **Context and Objective:** To fail before any AWS/SSM work when forwarding can't be honored, the agent check needs to run before `describeInstance`/`waitForSsmOnline`/`stageTemporarySshKey`. `ensureSshKeyMaterial` is purely local (no AWS dependency), so moving it earlier changes nothing about its own behavior or outputs.
- **Quality Attribute Tactics and Key Results:** Usability (fail fast, no wasted AWS calls or SSM wait when the request can never succeed) and cost (skips `describeInstance`/SSM wait/`stageTemporarySshKey` entirely on this failure path).
- **Options Considered:**
  - A: Leave `ensureSshKeyMaterial` where it is (after SSM wait) and add the new forwarding check as a separate, connect-only step before calling `resolveRemoteAccessPreconditions`. Keeps the shared function untouched, but requires a second local agent check (see prior decision) and doesn't reuse `ensureSshKeyMaterial`'s result.
  - B: Move `ensureSshKeyMaterial` to run immediately after SSH-user resolution (step 3.5) and add the new forwarding gate right after it, before `describeInstance`. `cp` calls the same function with `forwardAgent` defaulted to `false`, so the new gate is a no-op for `cp` and the reordering is invisible to it (the call itself is unaffected by AWS-derived state).
- **Decision:** Option B.
- **Consequences:** `resolveRemoteAccessPreconditions` gains an optional `forwardAgent` parameter (default `false`); `cp`'s call site is unchanged. The precondition chain now short-circuits before any AWS call when forwarding is requested without a usable agent, matching the `REMOTE-CLI-FAIL` precedent of failing before remote-access setup begins.

### Decision: Add `-A` only in `startInteractiveSsh`, not in shared `commonSshArgs()`

- **Context and Objective:** `commonSshArgs()` is shared by `startInteractiveSsh`, `uploadFileOverScp`, and `finalizeRemoteFile`. Only the interactive `connect` session should ever carry `-A`.
- **Quality Attribute Tactics and Key Results:** Isolation — guarantees `cp`'s code paths are byte-for-byte unaffected, satisfying the proposal's Out-of-Scope statement without relying on call-site discipline elsewhere.
- **Options Considered:**
  - A: Add a `forwardAgent` parameter to `commonSshArgs()` and pass `false` from the two `cp`-backing call sites. Centralizes the flag but adds a parameter to a shared helper for behavior only one of its three callers ever uses.
  - B: Keep `commonSshArgs()` untouched; add `forwardAgent: boolean = false` to `startInteractiveSsh` only, appending `-A` to its own args after spreading `commonSshArgs()`.
- **Decision:** Option B.
- **Consequences:** Zero-diff for `uploadFileOverScp`/`finalizeRemoteFile`. `startInteractiveSsh` gains one optional parameter with a safe default.

## Component Design

### Key Components
- **CLI parsing (`src/index.ts`)**: the `"connect"` case in `parseInvocation` gains recognition of a `--forward-agent` boolean flag, independent of and combinable in either order with `--ssh-user <user>`. `cp` parsing is untouched.
- **Precondition chain (`src/cli/remote-access.ts`)**: `resolveRemoteAccessPreconditions` gains an optional `forwardAgent` parameter; when `true`, it validates `keyResult.value.fromAgent` immediately after key-material resolution and before any AWS call.
- **Command (`src/cli/commands/connect.ts`)**: `runConnectCommand` gains an optional `forwardAgent` parameter, threaded into `resolveRemoteAccessPreconditions` and into `startInteractiveSsh`.
- **Adapter (`src/adapters/ssh-cli.ts`)**: `startInteractiveSsh` gains an optional `forwardAgent` parameter; when `true`, appends `-A` to the `ssh` invocation.

### Data Design
- `Invocation`'s `"connect"` variant (`src/index.ts`) gains `readonly forwardAgent?: boolean`. `"cp"` is unchanged — the capability is not exposed there.
- No changes to `StagedKey`, `SshContext`, `RemoteAccessContext`, or persisted config schema. No new encoding, storage, or validity rules beyond a boolean CLI flag (present/absent, no value).

### Interface Contracts
- `parseInvocation`: `connect` case additionally recognizes `--forward-agent` anywhere in the remaining args (order-independent relative to `--ssh-user <user>`); any other unconsumed argument is still rejected with the existing usage error (updated to mention the new flag).
- `resolveRemoteAccessPreconditions(invocationSshUser?: string, forwardAgent = false): Promise<Result<RemoteAccessContext, RemoteAccessPreconditionError>>` — new failure: `ValidationError` when `forwardAgent` is `true` and the resolved key material did not come from an agent (`fromAgent === false`), raised immediately after key-material resolution, before `describeInstance`.
- `runConnectCommand(invocationSshUser?: string, forwardAgent = false, clock = REAL_CLOCK): Promise<CommandResult>` — passes `forwardAgent` through to both `resolveRemoteAccessPreconditions` and `startInteractiveSsh`.
- `startInteractiveSsh(context: SshContext, key: StagedKey, forwardAgent = false): Promise<Result<number, RemoteTransportError>>` — appends `-A` to the spawned `ssh` args when `forwardAgent` is `true`. No change to its error contract.

### Code Map
- `src/index.ts` — `parseInvocation` (`"connect"` case, ~line 183), `Invocation` union (~line 60), `dispatch` (~line 289): parse and thread the new flag.
- `src/cli/remote-access.ts` — `resolveRemoteAccessPreconditions` (line 106): add `forwardAgent` parameter, reorder key-material resolution, add the new validation gate.
- `src/cli/commands/connect.ts` — `runConnectCommand` (line 80): accept and thread `forwardAgent`.
- `src/adapters/ssh-cli.ts` — `startInteractiveSsh` (line 537): accept `forwardAgent`, append `-A` conditionally. `commonSshArgs` (line 494), `uploadFileOverScp` (line 596), `finalizeRemoteFile` (line 652): unchanged.

## Failure and Reliability

### Failure Mode Analysis
- **Unsafe inputs:** `--forward-agent` is a bare boolean flag (no attacker-controlled value is embedded in SSH args); the only new argument appended to `ssh`'s argv is the fixed literal `-A`. No new injection surface.
- **Fragile formats:** none — no new encoding introduced.
- **Inadequate control actions:** without the new gate, requesting forwarding without a usable agent would silently connect without forwarding, discovered only when onward auth fails mid-session. Mitigated by the fail-fast `ValidationError`.
- **Process model flaws:** the design assumes agent state (`fromAgent`) observed during precondition resolution still holds moments later when `ssh` actually spawns. Agent state changing mid-invocation (user kills their agent between precondition check and session start) is a pre-existing class of race already accepted by `ensureSshKeyMaterial` for hop-auth key selection; this change doesn't introduce a new instance of it.
- **Coordination failures:** none — the change adds no concurrency; the precondition chain remains strictly sequential.

### Control and Recovery
- Forwarding-without-agent fails before any AWS/SSM call, with a `ValidationError` (exit code per the existing `ValidationError` mapping) and an actionable message (start `ssh-agent` / `ssh-add` a key, or omit `--forward-agent`).
- A remote host that rejects or ignores agent forwarding (`AllowAgentForwarding no`) is undetectable from the client side via SSM; per the proposal's failure-mode analysis, `connect` still succeeds — this is treated as an accepted external condition, not a defect.

## Operational Concerns

### Observability
No new logging/metrics needed: the failure surfaces as a normal CLI error (`[devbox] ValidationError: ...`) through the existing error-reporting path. No new secrets or key material are logged (agent forwarding never exposes private key bytes — that's the entire point of the agent protocol).

### Deployment and Rollout
Purely additive CLI capability; no feature flag needed since it's opt-in per invocation. No data migration. Rollback is a plain revert — no persisted state to unwind.

### Capacity and Scaling
Negligible: no new AWS API calls are added; the happy path adds a single boolean check on data already being computed.

## Security

Forwarding is opt-in per invocation only — never defaulted or persisted, so a compromised or untrusted devbox instance gains no new capability unless the user explicitly requests forwarding for that session. No private key material ever leaves the local machine or transits through devbox's own code — that is the security property SSH agent forwarding provides natively (the remote host talks to the local agent over a forwarded socket to request signatures, never receiving the key itself). Trust boundary: a malicious process with root on the remote host during a forwarded session can request arbitrary signatures from the local agent for the session's duration — this is inherent to SSH agent forwarding, not introduced by devbox, and is exactly why the proposal restricts scope to interactive `connect` sessions and explicitly excludes `cp`.

## Risks / Trade-offs

- [Reordering `ensureSshKeyMaterial` earlier in `resolveRemoteAccessPreconditions` changes the step numbering referenced by the base spec's `REMOTE-DOMAIN-PRECOND` Evidence/Alloy model] -> Mitigation: update the delta spec's requirement model and Evidence links in the specs artifact to reflect the new step order.
- [A remote host can silently ignore forwarding, giving no client-visible signal] -> Mitigation: documented as an accepted external condition in the proposal; not a client-detectable failure, so `connect` still succeeds.
- [Gating forwarding on `fromAgent` couples this feature to `REMOTE-ADAPTER-KEYSTORE`'s current "always prefer agent when available" behavior] -> Mitigation: if that preference logic ever changes, this gate must be revisited; documented here so future changes to `REMOTE-ADAPTER-KEYSTORE` review this dependency.

## Migration Plan
None. Purely additive, opt-in CLI flag; no data or config migration.

## Verification Strategy
- Property/unit test: `parseInvocation` accepts `--forward-agent` and `--ssh-user <user>` in either order for `connect`, and still rejects unconsumed positional args.
- Integration test: `resolveRemoteAccessPreconditions(user, true)` with a mocked `ensureSshKeyMaterial` returning `fromAgent: false` returns `ValidationError` and asserts `describeInstance`/`waitForSsmOnline`/`stageTemporarySshKey` are never called.
- Integration test: same, with `fromAgent: true`, proceeds through the full chain unchanged.
- Adapter test: `startInteractiveSsh` includes `-A` in spawned args iff `forwardAgent` is `true`; `uploadFileOverScp`/`finalizeRemoteFile` args are unaffected (regression guard on shared `commonSshArgs`).
- Manual smoke: `connect --forward-agent` to a real instance, confirm `ssh-add -l` on the remote host lists the local identity.

## Open Questions
- None outstanding — scope, failure modes, and rollback are fully determined by the proposal's constraints.
