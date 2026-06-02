## 1. CLI and Domain Scaffold

- [ ] 1.1 Create the layered TypeScript module structure for CLI, domain, adapters, build, and test entrypoints.
- [ ] 1.2 Add strict project tooling, package metadata, and command wiring for the `devbox` CLI entrypoint, including top-level help/version flag handling and no-argument dispatch to `list`.
- [ ] 1.3 Define shared error categories, result shapes, output contracts, and wait-policy constants used across command families.

### CLI and Domain Scaffold change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec -->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 2. Config Store and Registry Core

- [ ] 2.1 Implement config schema validation, including `defaults.sshUser`, optional per-box `sshUser`, alias rules, and current-box invariants.
- [ ] 2.2 Implement the config-store adapter with first-run synthesis, advisory locking, stale-lock recovery, temp-file write, `fsync`, and atomic replace.
- [ ] 2.3 Implement domain helpers for alias validation, instance-ID advisory warnings, SSH-user resolution precedence, and tag/default merge behavior.

### Config Store and Registry Core change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec -->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 3. Box Registry Commands

- [ ] 3.1 Implement `list`, `switch`, and local-only `rm` using the config-store and output contracts.
- [ ] 3.2 Implement `add <instance-id> <alias>` with active-account-and-region AWS validation and advisory instance-ID warnings.
- [ ] 3.3 Implement `init <alias> <template-file>` launch mapping, required-merge validation, tracked-box commit, and `ConsistencyError` handling.
- [ ] 3.4 Implement `rm --terminate` with explicit termination sequencing, already-absent handling, and cross-system divergence reporting.

### Box Registry Commands change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec -->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 4. Instance Lifecycle Commands

- [ ] 4.1 Implement the AWS adapter for instance description, start, stop, and normalized EC2 error handling.
- [ ] 4.2 Implement `up` with legal-state validation, stale-resource handling, bounded polling, and timeout reporting.
- [ ] 4.3 Implement `down` with legal-state validation, stale-resource handling, bounded polling, and timeout reporting.

### Instance Lifecycle Commands change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec -->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 5. Remote Access Commands

- [ ] 5.1 Implement SSM readiness checks and the remote-access domain flow for `connect` and `cp`, including active-context stale handling.
- [ ] 5.2 Implement temporary SSH key staging, 5-minute cleanup bounds, and SSH/SCP argv construction through the SSM-backed transport path.
- [ ] 5.3 Implement `connect` with invocation-time `--ssh-user`, `lastConnectAt` updates, and `ConsistencyError` behavior after session startup.
- [ ] 5.4 Implement `cp` with local-file validation, remote-path validation, temp-path upload, atomic remote finalization, cleanup, and `ConsistencyError` behavior after successful transfer.

### Remote Access Commands change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec -->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 6. Packaging and Distribution

- [ ] 6.1 Implement package metadata and build configuration that support standard `npm` installation of the `devbox` CLI.
- [ ] 6.2 Implement bundled output generation for `dist/devbox.js` with the exact required shebang and Node.js 20+ runtime contract.
- [ ] 6.3 Add parity checks and smoke-test scripts for top-level help/version behavior, the TypeScript entrypoint, the `npm`-installed CLI, and the bundled artifact.

### Packaging and Distribution change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec -->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 7. Verification and Evidence

- [ ] 7.1 Add contract tests for top-level help/version behavior, stdout, stderr, exit codes, and failure normalization across all command families.
- [ ] 7.2 Add property-based tests for config-store invariants, alias/current integrity, lifecycle state machines, and remote-access sequencing.
- [ ] 7.3 Add mocked integration-oriented tests for AWS/SSM/SSH boundary behavior, including `ConsistencyError` cases and cleanup paths.
- [ ] 7.4 Document traceability from requirements and scenarios to tests or other mechanical checks.

### Verification and Evidence change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec -->
<!-- Important information to pass on to other developers about the implementation of this task -->
