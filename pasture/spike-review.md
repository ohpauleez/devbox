# Compare `plan.md` Against `pasture/spike`

I treated `plan.md` as the target contract and `pasture/spike` as the current prototype.

## Bottom Line

The spike already aligns with a large share of the plan's core command semantics, especially around `init`, `list`, `up`/`down`, local config synthesis, and basic SSM/SSH flow. The biggest gaps are not in the happy-path command set, but in edge-case semantics, packaging/distribution, and test coverage.

## High Alignment

- Command surface matches the plan. The spike exposes `list`, `init`, `add`, `rm`, `switch`, `up`, `down`, `connect`, and `cp` via `commander` in `pasture/spike/src/index.ts:14-105`, which matches `plan.md:19-29`.
- Runtime/tool choices mostly match. The spike uses Node 20+, TypeScript, `commander`, `zod`, `vitest`, and `fast-check` in `pasture/spike/package.json:15-27`, matching `plan.md:31-41`.
- First-run config synthesis matches the plan closely. `synthesizeFirstRunConfig()` creates `boxes = {}`, no `current`, and only built-in tag defaults in `pasture/spike/src/domain/config-schema.ts:59-66`, matching `plan.md:129-140`.
- Config locking and atomic replace are substantially implemented. `mutateConfig()` creates the config dir, acquires a lock, reads current config, writes a temp file, `fsync`s it, renames it, `fsync`s the dir, and releases the lock in `pasture/spike/src/adapters/config-store.ts:187-205`, which is very close to `plan.md:282-329`.
- Stale lock detection also matches well. The spike checks PID validity, process liveness, and 5-minute staleness in `pasture/spike/src/adapters/config-store.ts:85-155`, matching `plan.md:297-308`.
- Alias validation matches. The regex in `pasture/spike/src/domain/alias.ts:3-12` matches `plan.md:153-160`.
- `init` flow is strongly aligned. The spike validates alias, loads template, prevents duplicate aliases before AWS launch, merges payload, launches exactly one instance, writes config, sets `current`, and reports `ConsistencyError` if config update fails after launch in `pasture/spike/src/cli/commands/init.ts:29-73`, matching `plan.md:347-360` and `plan.md:575-586`.
- `init` allowlist and explicit rejection of `InstanceRequirements` match `plan.md:362-401`, implemented in `pasture/spike/src/domain/init-mapper.ts:6-71`.
- Tag merge behavior is close to plan. Built-in defaults, config defaults, template instance tags, forced `Name`, and required-tag validation are implemented in `pasture/spike/src/domain/tags.ts:26-77`, matching `plan.md:196-212`.
- `list` behavior matches the intended "local-first, optional AWS enrichment" model. It falls back to `unknown` on AWS/dependency failure and marks omitted described instances as `stale` in `pasture/spike/src/cli/commands/list.ts:23-80`, matching `plan.md:528-559`.
- `up`/`down` behavior matches the plan closely. Accepted transitional states, conditional start/stop, wait-loop behavior, and invalid `shutting-down`/`terminated` handling are implemented in `pasture/spike/src/cli/commands/up.ts:26-49`, `pasture/spike/src/cli/commands/down.ts:26-49`, and `pasture/spike/src/domain/instance-state.ts:12-28`, matching `plan.md:431-450`, `plan.md:660-712`.
- Wait intervals and timeouts match exactly. `5s` polling, `5m` EC2 timeout, and `2m` SSM timeout are in `pasture/spike/src/domain/wait-policy.ts:1-4`, matching `plan.md:431-457`.
- `cp` uses temp-path upload then final move, and validates remote paths against control characters in `pasture/spike/src/cli/commands/cp.ts:40-85` and `pasture/spike/src/domain/remote-path.ts:3-20`, matching much of `plan.md:168-177` and `plan.md:460-488`.
- Exit-code mapping matches the plan exactly in `pasture/spike/src/domain/errors.ts:12-22`, matching `plan.md:835-846`.

## Material Mismatches

- `add` behavior conflicts with the main command contract in the plan. The plan says `add` sets `current = alias` on success in `plan.md:604-608`, but the spike only sets `current` when absent in `pasture/spike/src/cli/commands/add.ts:29-42`. The plan later contradicts itself by listing "`add` sets `current` only when absent" in `plan.md:901-903`. The spike has chosen one side of an unresolved spec conflict.
- The global invariant for stored instance IDs is stricter in the plan than in the spike. `plan.md:808-818` says every stored `instanceId` matches EC2 format, but the spike only warns on odd-looking IDs in `pasture/spike/src/domain/alias.ts:14-21` and the config schema only requires `instanceId` to be a non-empty string in `pasture/spike/src/domain/config-schema.ts:4-7`. This is also internally inconsistent with `plan.md:161-167`, which says odd formats should warn, not reject.
- `rm --terminate` does not report post-AWS/local-config divergence explicitly. The plan says config write failure after accepted termination should be reported clearly as divergence in `plan.md:629-635`, but the spike just calls `terminate()` and then `mutateConfig()` without wrapping later failures as `ConsistencyError` in `pasture/spike/src/cli/commands/rm.ts:30-48`.
- `connect` and `cp` have the same divergence issue for `lastConnectAt`. In both commands, the remote action succeeds first and then local config mutation happens afterward in `pasture/spike/src/cli/commands/connect.ts:35-53` and `pasture/spike/src/cli/commands/cp.ts:64-83`. If the config write fails, the spike will surface a plain config error rather than an explicit local/remote divergence, which is weaker than the spirit of `plan.md:803-804`.
- `init` conditional validation is only partially implemented. The plan says that when `NetworkInterfaces` is present, the tool should also require security groups under `NetworkInterfaces[*].Groups` and reject other interface-scoped top-level conflicts in `plan.md:403-410`. The spike only rejects top-level `SecurityGroupIds` and `SecurityGroups` in `pasture/spike/src/domain/init-mapper.ts:87-95`.
- The spike does not implement the proposed project structure or distribution shape. `plan.md:243-278` and `plan.md:71-80` expect a main `src/` tree plus `build/esbuild.ts` and `dist/devbox.js`. The repo has no top-level `src/` implementation, only `pasture/spike/src/*`, and `pasture/spike/package.json:6-14` builds `dist/index.js`, not a single-file `dist/devbox.js` artifact with shebang preservation.
- The spike does not yet implement the "same CLI behavior for npm-installed CLI and bundled single-file artifact" requirement in `plan.md:73-80` and `plan.md:911-913`. There is no bundle pipeline yet.
- The plan's security note about temporary SSH key swapping is not reflected in the spike. `plan.md:864-865` says `connect` and `cp` manage a temporary SSH key swap as in `ssh-ssm.sh`, but the spike simply relies on local SSH configuration and an injected `ProxyCommand` in `pasture/spike/src/adapters/ssh-cli.ts:12-59`. This actually aligns better with `plan.md:466-473` and `plan.md:468-469`, so the mismatch is partly a plan inconsistency.
- `cp` cleanup is weaker than the plan suggests. The plan says best-effort remote cleanup should happen on failure in `plan.md:470-487`. The spike only calls cleanup when the final `mv` fails in `pasture/spike/src/adapters/ssh-cli.ts:41-58`; it does not attempt cleanup if `scp` itself partially uploads then fails.
- The spike adds behavior not mentioned in the plan: `DEVBOX_CONFIG_DIR` overrides the config location in `pasture/spike/src/adapters/config-store.ts:14-28`. That is useful for tests, but it is extra behavior relative to the fixed-path rule in `plan.md:810`.

## Partial Alignment / Under-Specified Areas

- `connect` says it requires local `ssh` executables in `plan.md:719-726`; the spike does rely on `ssh`, but dependency detection is indirect through process execution in `pasture/spike/src/adapters/process.ts:10-84` and `pasture/spike/src/adapters/ssh-cli.ts:12-25`.
- `cp` preconditions mention absolute or shell-resolvable remote paths in `plan.md:756-758`, but the spike only validates non-empty plus no control characters in `pasture/spike/src/domain/remote-path.ts:3-20`. That may be intentional minimalism, but it is less explicit than the plan.
- The error output contract is close but simpler than described. The spike prints `Code: message` plus optional details in `pasture/spike/src/domain/errors.ts:47-52`, which is compatible with `plan.md:519-523` and `plan.md:848-854`, but not especially normalized beyond that.

## Testing: What the Spike Covers

- Basic contract tests exist for `init`, `switch`, `up`/`down`, config schema, remote path validation, wait loops, and simple invariants in `pasture/spike/test/*.ts`.
- The property-based coverage is still very light compared with the plan. `pasture/spike/test/invariants.property.test.ts:1-51` checks schema validity and `current` integrity over a simple generated add/switch/rm model, but it does not yet model EC2 lifecycle, SSM readiness, config-store crash safety, or `cp` transfer sequencing the way `plan.md:879-946` calls for.
- There are no visible tests yet for `add`, `rm`, `list` batching/fallback behavior, `connect`, `cp`, subprocess stderr normalization, build/package contracts, or lock-file recovery behavior, all of which are explicitly called for in `plan.md:889-964`.

## Where the Spike Is Strongest

```text
strongly realized
├── command routing
├── config synthesis + schema validation
├── atomic local writes + stale lock recovery
├── init happy-path + consistency error
├── list enrichment fallback
├── up/down transition rules
└── basic ssh-over-ssm transport shape
```

## Where the Plan Still Exceeds the Spike

```text
planned but not fully realized
├── single-file dist/devbox.js artifact
├── full init conflict validation
├── explicit divergence handling after rm/connect/cp
├── broader subprocess/dependency contracts
├── comprehensive property/state-machine tests
└── packaged top-level implementation layout
```

## The Biggest Spec Questions To Resolve

1. Should `add` always switch `current`, or only when `current` is unset?
2. Are stored instance IDs required to be regex-valid, or only warned on?
3. Should post-success local-write failures in `rm`, `connect`, and `cp` become `ConsistencyError` like `init`?
4. Does the product intend to manage any SSH key swap behavior, or rely entirely on the user's SSH config?
5. Is `pasture/spike` intended to graduate into the main implementation, or stay as a learning prototype while a clean `src/` tree is created?

## Possible Next Step

If needed, this can be tightened into a gap matrix next:

```text
plan section -> spike status -> recommended decision
```
