## Purpose

Enforce bidirectional traceability between OpenSpec requirements and tests via a Mocha root-hook plugin that auto-discovers spec identifiers and validates test coverage at suite time.

## Requirements

### Requirement: Spec Parser SHALL Auto-Discover and Extract Identifiers

When the test suite boots, the harness SHALL recursively scan all markdown files under a configurable base directory (default: `openspec/`), excluding archived changes, and extract identifiers matching the pattern PREFIX-DESCRIPTIVE-NAME in square brackets.

#### Scenario: Identifiers extracted from spec headings `[STH-PARSE-HEADING]`

- **WHEN** spec files contain identifiers on scenario headings
- **THEN** the harness recognizes all identifiers with correct line provenance

#### Scenario: Identifiers extracted from inline text `[STH-PARSE-INLINE]`

- **WHEN** spec files contain identifiers in inline text or bullets
- **THEN** the harness recognizes all identifiers regardless of document position

### Requirement: Cross-File Duplicate Identifiers SHALL Cause Boot Error

If the same identifier appears in more than one spec file, the harness SHALL report an error at suite boot. Reuse within a single file is permitted.

#### Scenario: Same identifier in two spec files `[STH-DUP-CROSS-FILE]`

- **WHEN** identifier X is defined in both specs/a/spec.md and specs/b/spec.md
- **THEN** the harness reports an error naming both files and their line numbers

#### Scenario: Same identifier repeated within one file `[STH-DUP-SAME-FILE]`

- **WHEN** identifier X appears multiple times in the same spec file
- **THEN** the harness does not report an error

### Requirement: Unknown Reference SHALL Cause Test Failure

When a test declares a spec identifier not found in any spec file, the harness SHALL report an error immediately.

#### Scenario: Test declares valid identifier `[STH-REF-VALID]`

- **WHEN** a test calls specId with an identifier that exists in a spec file
- **THEN** the harness registers the declaration without error

#### Scenario: Test declares non-existent identifier `[STH-REF-UNKNOWN]`

- **WHEN** a test calls specId with an identifier not found in any spec file
- **THEN** the harness throws an error listing the unknown identifier and all known identifiers

### Requirement: Bijective Coverage SHALL Be Enforced on Full Suite

When running the full test suite, each spec identifier SHALL be declared by exactly one test.

#### Scenario: Uncovered identifier fails the suite `[STH-COV-UNCOVERED]`

- **WHEN** the full suite completes
- **AND** spec identifier X was not declared by any test
- **THEN** the harness reports uncovered identifiers with file and line provenance

#### Scenario: All identifiers covered passes the suite `[STH-COV-COMPLETE]`

- **WHEN** every spec identifier is declared by exactly one test
- **THEN** the harness reports no coverage errors

### Requirement: Coverage Enforcement SHALL Be Independently Controllable

The harness SHALL allow coverage enforcement to be disabled independently of reference validation, so subset runs do not fail on uncovered identifiers.

#### Scenario: Coverage disabled via environment variable `[STH-COV-DISABLED]`

- **WHEN** SPEC_COVERAGE=false is set
- **THEN** the harness does not report uncovered identifiers after the suite
- **AND** unknown-reference detection remains active
