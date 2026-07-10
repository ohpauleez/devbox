## 1. CLI flag parsing

- [x] 1.1 Add `readonly forwardAgent?: boolean` to the `"connect"` variant of `Invocation` in `src/index.ts`. Do not add it to `"cp"`.
- [x] 1.2 In `parseInvocation`'s `"connect"` case, recognize a `--forward-agent` boolean flag alongside `--ssh-user <user>`, accepted in either order; any other unconsumed argument still produces the existing `"usage: devbox connect [--ssh-user <user>]"` error (update the message to mention `[--forward-agent]`).
- [x] 1.3 Leave `cp`'s parsing (`parseOptionalSshUser`) untouched, so `--forward-agent` passed to `cp` falls through as an unconsumed argument and triggers the existing `"usage: devbox cp <local> <remote>"` invalid-invocation error.
- [x] 1.4 In `dispatch()`, pass `invocation.forwardAgent` through to `runConnectCommand`. Completed alongside Task Group 4 once `runConnectCommand`'s signature accepted the new parameter.

### CLI flag parsing change summary
Added a new `extractForwardAgentFlag()` helper (`src/index.ts`, next to `parseOptionalSshUser`) that removes a `--forward-agent` token from anywhere in the `connect` argument list, independent of position relative to `--ssh-user <user>`. The `connect` case now strips `--forward-agent` first, then runs the existing head-anchored `parseOptionalSshUser` on what's left — this lets the two flags appear in either order without touching `cp`'s parsing at all (`cp` never calls `extractForwardAgentFlag`, so `--forward-agent` there is left in `rest` and rejected by the existing "usage: devbox cp ..." check, satisfying `REMOTE-FWDAGENT-CPREJECT` for free).

Decision not fully specified in the spec: tokens are matched as whole flag units in either order (`--forward-agent --ssh-user bob` or `--ssh-user bob --forward-agent`), not arbitrary interleaving of individual tokens (e.g. `--ssh-user --forward-agent bob` is not specifically guarded against and would misparse) — the spec's "either order" language is about the two complete flags, not free token order, so this was judged sufficient without a general-purpose flag parser.

Verified: `npx tsc --noEmit`, `npx eslint src/index.ts`, and the existing `remote-commands.integration.test.ts` / `remote-access.contract.test.ts` / `ssh-cli.contract.test.ts` suites (28 tests) all pass unchanged — confirms no regression to existing `connect`/`cp` parsing. New parsing behavior itself is not yet test-covered — that's Task 5.1/5.2.

## 2. Precondition chain: reorder and gate

- [x] 2.1 In `resolveRemoteAccessPreconditions` (`src/cli/remote-access.ts`), add an optional `forwardAgent = false` parameter.
- [x] 2.2 Move the `ensureSshKeyMaterial()` call from its current position (after SSM-online wait) to immediately after SSH-user resolution, before `describeInstance`. Confirm this reordering has no effect on `ensureSshKeyMaterial`'s own inputs/outputs (it depends on no AWS-derived state).
- [x] 2.3 Immediately after resolving key material, add the gate: if `forwardAgent` is `true` and `keyResult.value.fromAgent` is `false`, return `err(makeTypedError("ValidationError", ...))` with an actionable message (start `ssh-agent` / `ssh-add` a key, or omit `--forward-agent`) before calling `describeInstance`.
- [x] 2.4 Confirm `cp`'s call site (`runCpCommand`) is unchanged — it never passes `forwardAgent`, so the new gate is always a no-op for `cp`.

### Precondition chain change summary
Reordered `resolveRemoteAccessPreconditions` (`src/cli/remote-access.ts`) so `ensureSshKeyMaterial()` (step 4) now runs immediately after SSH-user resolution, before `describeInstance`/`waitForSsmOnline`/`stageTemporarySshKey`. Added the new step 5 gate: `if (forwardAgent && !keyResult.value.fromAgent) return err(makeTypedError("ValidationError", ...))`. Both module and function docstrings were updated to describe the new 9-step order and the new `ValidationError` failure form. `runCpCommand` (`src/cli/commands/cp.ts`) was not touched — it calls `resolveRemoteAccessPreconditions(invocationSshUser)` with `forwardAgent` defaulted to `false`, so the new gate never fires for `cp` and the reordering is behaviorally invisible to it (confirmed by the unchanged `remote-commands.integration.test.ts` results).

Decision not fully specified in the spec: rather than adding a second `ssh-add -l` check, the gate reuses `ensureSshKeyMaterial`'s existing `fromAgent` result (this was already the plan from `design.md`'s Architecture Decisions, implemented here as written).

Fallout requiring a fix not itemized in this task group: two pre-existing tests in `test/integration/remote-access.integration.test.ts` (`REMOTE-PRECOND-FAIL` scenarios for non-running instance and SSM timeout) asserted `ensureSshKeyMaterialMock` was **not** called before those AWS-level failures — true under the old order, false now that step 4 always runs first. Updated both assertions to `toHaveBeenCalledTimes(1)` with an explanatory comment; the more important assertions (`stageTemporarySshKeyMock`/`waitForSsmOnlineMock` not called) are preserved unchanged, since staging still never happens once the instance/SSM check fails.

Verified: `npx tsc --noEmit`, `npx eslint src/cli/remote-access.ts`, and the full test suite (`npx vitest run`) — 215/215 tests passing, no regressions beyond the two intentionally-updated assertions above.

## 3. Adapter: interactive session forwarding

- [x] 3.1 Add an optional `forwardAgent = false` parameter to `startInteractiveSsh` (`src/adapters/ssh-cli.ts`). When `true`, append `-A` to the spawned `ssh` args after spreading `commonSshArgs()`.
- [x] 3.2 Do not modify `commonSshArgs()`, `uploadFileOverScp`, or `finalizeRemoteFile` — forwarding must only ever apply to the interactive session.

### Adapter change summary
`startInteractiveSsh` (`src/adapters/ssh-cli.ts`) gained a third optional parameter, `forwardAgent = false`. The spawned `ssh` args are now `[...commonSshArgs(context, key), ...(forwardAgent ? ["-A"] : []), "<user>@<instanceId>"]` — `-A` is appended after the shared args, not inside `commonSshArgs()` itself, so `uploadFileOverScp` and `finalizeRemoteFile` (the two `cp`-backing functions that also call `commonSshArgs()`) are untouched by this change, exactly as `design.md`'s "Add `-A` only in `startInteractiveSsh`" decision specified. No new validation was added here — the docstring notes that callers (i.e. `runConnectCommand`, in the next task group) are responsible for having already validated the forwarding precondition via `resolveRemoteAccessPreconditions`.

Verified: `npx tsc --noEmit`, `npx eslint src/adapters/ssh-cli.ts`, and the full test suite (`npx vitest run`) — 215/215 passing, no regressions. New behavior (`-A` present/absent, `cp` paths unaffected) is not yet test-covered — that's Task 5.5/5.6.

## 4. Command wiring

- [x] 4.1 Add an optional `forwardAgent = false` parameter to `runConnectCommand` (`src/cli/commands/connect.ts`), threaded into both `resolveRemoteAccessPreconditions(invocationSshUser, forwardAgent)` and `startInteractiveSsh(sshContext, key, forwardAgent)`.

### Command wiring change summary
`runConnectCommand` (`src/cli/commands/connect.ts`) gained a second parameter, `forwardAgent = false`, inserted before the existing `clock` parameter (now third). It's passed straight through to both `resolveRemoteAccessPreconditions(invocationSshUser, forwardAgent)` and `startInteractiveSsh(sshContext, key, forwardAgent)`. `dispatch()` in `src/index.ts` now calls `runConnectCommand(invocation.sshUserOverride, invocation.forwardAgent)`, closing out Task 1.4 from Group 1. Docstrings for `runConnectCommand` were updated to document the new parameter and the `ValidationError` failure form it can trigger via the precondition chain.

Decision not fully specified in the spec: `forwardAgent` was inserted as the *second* positional parameter (before `clock`) rather than appended at the end, matching the existing convention where `clock` — a test-only seam — stays last. No test in the repo called `runConnectCommand` with a positional `clock` argument, so this reordering had no call-site fallout beyond the one argument-shape assertion noted below.

Fallout requiring a fix not itemized in this task group: `test/integration/remote-commands.integration.test.ts`'s "connect forwards invocation ssh user override to remote-access preconditions" test asserted `resolveRemoteAccessPreconditionsMock` was called with just `("ubuntu")`; it's now called with `("ubuntu", false)` since `runConnectCommand` always passes `forwardAgent` through explicitly (defaulted to `false`, not omitted). Updated the assertion to `toHaveBeenCalledWith("ubuntu", false)`.

Verified: `npx tsc --noEmit`, `npx eslint src/index.ts src/cli/commands/connect.ts`, and the full test suite (`npx vitest run`) — 215/215 passing. End-to-end wiring (CLI flag → command → precondition gate → adapter `-A`) is now complete and compiles/runs correctly, though the new behavior itself still has no dedicated tests — that's Task Group 5.

## 5. Tests

- [x] 5.1 `test/property/ssh-user.property.test.ts` or a new CLI-parsing test: `parseInvocation` accepts `connect --forward-agent --ssh-user <user>` and `connect --ssh-user <user> --forward-agent` identically, and still rejects extra positional args. Trace `REMOTE-CLI-FORWARDAGENT`, `REMOTE-FWDAGENT-PARSE`.
- [x] 5.2 Test that `cp --forward-agent <local> <remote>` (in any position) is rejected as invalid before any remote-access setup. Trace `REMOTE-FWDAGENT-CPREJECT`.
- [x] 5.3 `test/integration/remote-access.integration.test.ts`: with `ensureSshKeyMaterial` mocked to return `fromAgent: false`, call `resolveRemoteAccessPreconditions(user, true)`, assert it returns `ValidationError` and that `describeInstance`, `waitForSsmOnline`, and `stageTemporarySshKey` are never invoked. Trace `REMOTE-DOMAIN-FORWARDAGENT`, `REMOTE-FWDAGENT-FAIL`.
- [x] 5.4 Same fixture with `fromAgent: true`: assert `resolveRemoteAccessPreconditions(user, true)` proceeds through the full chain unchanged. Trace `REMOTE-FWDAGENT-READY`.
- [x] 5.5 `test/contract/ssh-cli.contract.test.ts`: assert `startInteractiveSsh(context, key, true)` includes `-A` in the spawned `ssh` args, and `startInteractiveSsh(context, key, false)` (and the existing no-arg call) does not. Trace `REMOTE-ADAPTER-FORWARDAGENT`, `REMOTE-FWDAGENT-SESSION`.
- [x] 5.6 Regression test in the same file: `uploadFileOverScp` and `finalizeRemoteFile` args are unchanged (no `-A`, `commonSshArgs()` output identical to before this change). Trace `REMOTE-FWDAGENT-CPSAFE`.
- [x] 5.7 Add a review-only traced test (per `TRACE-REVIEW-ONLY`) with an explanatory comment for `REMOTE-FWDAGENT-TOLERATE`: remote `sshd` rejecting agent forwarding is not observable or reproducible from the client side in an automated test, so this scenario is verified by code review of `startInteractiveSsh`'s exit-code handling rather than a behavioral assertion.

### Tests change summary
Added tests across four files, one per architectural layer touched by this change:

- **CLI layer** (new file `test/integration/connect-forward-agent.integration.test.ts`): exercises the real `runCli()` entrypoint end-to-end (parse → dispatch → command), with `resolveRemoteAccessPreconditions`, `startInteractiveSsh`, and `commitConfig` mocked at the module boundary (same pattern as `remote-commands.integration.test.ts`, one level up the call stack). Covers `--forward-agent`/`--ssh-user` in either order (`REMOTE-CLI-FORWARDAGENT`, `REMOTE-FWDAGENT-PARSE`), the no-flag default-preserving case, and `cp --forward-agent` rejection before any remote-access setup (`REMOTE-FWDAGENT-CPREJECT`, asserting the mocked functions are never called).
- **Domain layer** (`test/integration/remote-access.integration.test.ts`): two new tests using the existing mock fixtures — `fromAgent: true` continues through to staging (`REMOTE-DOMAIN-FORWARDAGENT`, `REMOTE-FWDAGENT-READY`), `fromAgent: false` (the `beforeEach` default) fails with `ValidationError` and asserts zero calls to `describeInstance`/`waitForSsmOnline`/`stageTemporarySshKey` (`REMOTE-FWDAGENT-FAIL`).
- **Adapter layer** (`test/contract/ssh-cli.contract.test.ts`): added a `node:child_process` mock (this module previously only mocked `runProcess` and `node:fs/promises` — `startInteractiveSsh` uses raw `spawn` directly for its interactive stdio, so it had **no prior test coverage at all**, forwarding or otherwise). Used an `EventEmitter` standing in for the child process to trigger the `"close"` handler. Covers `-A` present when `forwardAgent: true`, absent when `false`, and absent when omitted entirely (`REMOTE-ADAPTER-FORWARDAGENT`, `REMOTE-FWDAGENT-SESSION`). Also added a regression test asserting `uploadFileOverScp`/`finalizeRemoteFile` (the `cp`-backing functions, already using the pre-existing mocked `runProcess`) never emit `-A` (`REMOTE-FWDAGENT-CPSAFE`), and a `REVIEW:`-prefixed trivial-assertion test tracing `REMOTE-FWDAGENT-TOLERATE` with an explanatory comment, per `TRACE-REVIEW-ONLY`.

**Unplanned but necessary production fix**: writing the CLI-layer test required importing `runCli` from `src/index.ts`, which exposed a latent bug — that module unconditionally self-invokes `void runCli(process.argv.slice(2))` at module scope, so merely *importing* any export from it (as `runCli`'s own JSDoc `@example` implies is supported) triggered a real CLI run against the actual environment (surfaced as an unhandled rejection from `runListCommand`'s unmocked `loadConfig`, since the test runner's own `process.argv` parsed to the default `list` invocation). Fixed by adding a standard `import.meta.url`-vs-`process.argv[1]` main-module guard around that self-invocation in `src/index.ts` (see Task Group 1 files — this was applied as part of this task, not Group 1, since it was only discovered here). Verified this doesn't change real CLI behavior: `distribution.integration.test.ts`'s parity tests (which spawn both `dist/src/index.js` and the bundled `dist/devbox.js` as real subprocesses) still pass unchanged. No prior test exercised this path (confirmed via repo-wide search — this was the first test to import `src/index.ts`), so this had been a dormant risk independent of this feature.

Also caught mid-authoring: an `expect(...).toHaveBeenCalledWith(...)` assertion placed *after* `spy.mockRestore()` silently sees zero calls, because `mockRestore()` also clears recorded call history (not just the implementation). Fixed by asserting before restoring.

Verified: `npx tsc --noEmit`, `npx eslint` on all touched files, `npx vitest run` (223/223 passing), and `npm run test:trace` (full-suite coverage mode) — exit code 0, no uncovered-identifier report, confirming all 10 new canonical identifiers are traced.

## 6. Verification

- [x] 6.1 Run the full-suite trace coverage command (`test:trace` or equivalent) and confirm all 10 new canonical identifiers (`REMOTE-CLI-FORWARDAGENT`, `REMOTE-FWDAGENT-PARSE`, `REMOTE-FWDAGENT-CPREJECT`, `REMOTE-DOMAIN-FORWARDAGENT`, `REMOTE-FWDAGENT-READY`, `REMOTE-FWDAGENT-FAIL`, `REMOTE-ADAPTER-FORWARDAGENT`, `REMOTE-FWDAGENT-SESSION`, `REMOTE-FWDAGENT-CPSAFE`, `REMOTE-FWDAGENT-TOLERATE`) are covered.
- [x] 6.2 Run the full test suite, lint, and typecheck.
- [x] 6.3 Manual smoke test (partial — see note below).

### Verification change summary
- **6.1**: `npm run test:trace` (`DEVBOX_TRACE_COVERAGE=1 vitest run`) exits 0 with no uncovered-identifier report — all 10 new identifiers are declared by at least one traced test.
- **6.2**: `npx tsc --noEmit`, `npx eslint "src/**/*.ts" "test/**/*.ts" "build/**/*.ts" --max-warnings=0`, and `npx vitest run` all pass clean (223/223 tests, zero lint warnings, zero type errors).
- **6.3**: Ran `npm run build` and exercised the real built binary (`dist/src/index.js`) for the parts of the feature that don't require live AWS access:
  - `connect --forward-agent --bogus` → `usage: devbox connect [--ssh-user <user>] [--forward-agent]`, exit 2 (updated usage text confirmed on the actual binary, not just in-process).
  - `cp --forward-agent local.txt /remote/path.txt` → `usage: devbox cp <local> <remote>`, exit 2, and confirmed no `local.txt` was created/touched on disk.
  - **Not performed**: an actual `devbox connect --forward-agent` session against a real EC2 instance. This environment has no AWS credentials or provisioned devbox instance, and running it without those would either fail uninformatively or (worse) make real AWS/SSM calls against whatever credentials happen to be configured — not something to do speculatively. This step should be run manually by someone with a live devbox instance before this change is considered fully verified end-to-end; everything up to the real network hop (parsing, precondition gating, adapter argument construction) is covered by the automated tests in Task Group 5.
