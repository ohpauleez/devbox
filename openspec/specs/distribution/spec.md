## Purpose

Define the supported distribution contracts for `devbox` so the CLI can be installed through `npm` and shipped as a bundled `dist/devbox.js` artifact while preserving the same user-visible behavior, help/version surface, outputs, exit codes, and Node.js runtime expectations.
This spec carries forward the intent that packaging is part of the product contract rather than a secondary build concern.

## Requirements

### Requirement: Primary NPM Distribution [DIST-CLI-NPM]
THE devbox system SHALL support installation and update through `npm` as the primary distribution path.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Capabilities`

#### Scenario: NPM Installed CLI Available [DIST-NPM-SUCCESS]
WHEN the package is installed through `npm`, THE devbox system SHALL expose the `devbox` CLI using standard Node.js package installation behavior.

**Postcondition:** Users can invoke `devbox` after supported installation.

#### Scenario: Broken Package Metadata Rejected [DIST-NPM-FAIL]
IF package metadata or build outputs do not support standard `npm` installation of the CLI, THEN THE devbox system SHALL fail verification for the distribution capability.

**Postcondition:** The unsupported package shape is not accepted as release-ready.

### Requirement: Single File Artifact [DIST-CLI-BUNDLE]
THE devbox system SHALL support an additional bundled distribution artifact at `dist/devbox.js` that runs under Node.js 20+ without requiring the TypeScript source tree at runtime.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`

#### Scenario: Bundle Output Has Shebang [DIST-BUNDLE-SHEBANG]
WHEN the bundled artifact is built successfully, THE devbox system SHALL emit exactly one JavaScript file at `dist/devbox.js` whose first line is `#!/usr/bin/env node`.

**Postcondition:** The bundled artifact is directly executable as a POSIX CLI entrypoint.

#### Scenario: Missing Runtime Contract Rejected [DIST-BUNDLE-FAIL]
IF the bundled artifact depends on the TypeScript source tree or omits the required shebang, THEN THE devbox system SHALL fail verification for the bundled distribution contract.

**Postcondition:** The artifact is not accepted as a supported distribution form.

### Requirement: Distribution Parity [DIST-DOMAIN-PARITY]
THE devbox system SHALL preserve the same command behavior, exit codes, stdout contracts, and stderr contracts across the `npm`-installed CLI and the bundled `dist/devbox.js` artifact.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Help And Local Commands Match [DIST-PARITY-SMOKE]
WHEN equivalent local-only commands are executed through the `npm`-installed CLI and the bundled artifact, THE devbox system SHALL produce the same user-visible behavior.

**Postcondition:** The supported distribution forms remain interchangeable for documented CLI behavior.

#### Scenario: Contract Drift Rejected [DIST-PARITY-FAIL]
IF a supported distribution form produces different exit codes or output contracts for the same documented command behavior, THEN THE devbox system SHALL fail verification for distribution parity.

**Postcondition:** Distribution contract drift is treated as a release-blocking defect.

### Requirement: Top Level Help And Version Parity [DIST-CLI-META]
THE devbox system SHALL preserve the same top-level `-v` and `--version` behavior and the same top-level `-h` and `--help` behavior across the `npm`-installed CLI and the bundled `dist/devbox.js` artifact.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Context`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Version Output Matches [DIST-VERSION-PARITY]
WHEN the user invokes top-level version flags through supported distribution forms, THE devbox system SHALL produce equivalent version output and successful exit behavior.

**Postcondition:** Version reporting remains interchangeable across supported distribution forms.

#### Scenario: Help Output Matches [DIST-HELP-PARITY]
WHEN the user invokes top-level help flags through supported distribution forms, THE devbox system SHALL produce equivalent help output, version output inclusion, and successful exit behavior.

**Postcondition:** Help reporting remains interchangeable across supported distribution forms.
