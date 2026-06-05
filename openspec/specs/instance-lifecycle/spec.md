## Purpose

Define the lifecycle-control behavior for the current tracked `devbox` machine, with the active AWS account and region treated as authoritative for live state.
This spec captures the explicit lifecycle state machines, stale-resource handling, bounded polling, timeout reporting, and normalized failures so `up` and `down` remain predictable, safe, and mechanically testable.

## Requirements

### Requirement: CLI Lifecycle Commands [LIFE-CLI-CMDS]
THE devbox CLI SHALL provide `up` and `down` commands that operate on the current tracked box.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Capabilities`

#### Scenario: Current Box Required [LIFE-CURRENT-REQ]
IF the user invokes `up` or `down` and no current box is selected, THEN THE devbox CLI SHALL fail with a normalized error summary.

**Postcondition:** No AWS lifecycle request is sent.

#### Scenario: Lifecycle Success Prints Instance [LIFE-CLI-SUCCESS]
WHEN `up` or `down` succeeds, THE devbox CLI SHALL print the targeted instance ID on stdout.

**Postcondition:** Stdout contains a single-line instance identifier.

### Requirement: Active Context Scoping [LIFE-DOMAIN-SCOPE]
THE devbox domain SHALL evaluate tracked instance state against only the active AWS account and region at command time.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Context`

#### Scenario: Active Context Defines Validity [LIFE-SCOPE-ACTIVE]
WHEN a lifecycle command describes the tracked instance, THE devbox domain SHALL use the user's active AWS account and region as the only lookup context.

**Postcondition:** State and existence checks are tied to the active command environment.

#### Scenario: Cross Context Tracking Not Supported [LIFE-SCOPE-FAIL]
IF a tracked instance is not describable in the active AWS account or region, THEN THE devbox domain SHALL treat the box as stale rather than attempting profile or region discovery.

**Postcondition:** The command does not mutate AWS state through guessed alternate contexts.

### Requirement: Up State Machine [LIFE-DOMAIN-UP]
WHEN `up` is invoked, THE devbox domain SHALL accept `stopped`, `pending`, or `running` as legal starting states and SHALL reject `shutting-down` or `terminated`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Stopped Instance Started [LIFE-UP-START]
WHEN the current instance state is `stopped`, THE devbox domain SHALL send a start request and wait for `running`.

**Postcondition:** The command succeeds only after observing `running` within the timeout bound.

#### Scenario: Invalid Up State Rejected [LIFE-UP-FAIL]
IF the current instance state is `shutting-down` or `terminated`, THEN THE devbox domain SHALL fail with `InstanceStateError` and SHALL NOT send a start request.

**Postcondition:** No invalid lifecycle transition is requested.

### Requirement: Down State Machine [LIFE-DOMAIN-DOWN]
WHEN `down` is invoked, THE devbox domain SHALL accept `running`, `stopping`, or `stopped` as legal starting states and SHALL reject `shutting-down` or `terminated`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Running Instance Stopped [LIFE-DOWN-STOP]
WHEN the current instance state is `running`, THE devbox domain SHALL send a stop request and wait for `stopped`.

**Postcondition:** The command succeeds only after observing `stopped` within the timeout bound.

#### Scenario: Invalid Down State Rejected [LIFE-DOWN-FAIL]
IF the current instance state is `shutting-down` or `terminated`, THEN THE devbox domain SHALL fail with `InstanceStateError` and SHALL NOT send a stop request.

**Postcondition:** No invalid lifecycle transition is requested.

### Requirement: Stale Resource Handling [LIFE-DOMAIN-STALE]
IF a lifecycle command targets a tracked box whose instance is missing or no longer describable in the active AWS account and region, THEN THE devbox domain SHALL fail with `NotFoundError`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Stale Instance Rejected [LIFE-STALE-FAIL]
IF the current tracked instance cannot be described in the active AWS account and region, THEN THE devbox domain SHALL reject `up` or `down` without mutating local config.

**Postcondition:** The tracked alias remains present and AWS state is unchanged.

#### Scenario: Live Instance Continues [LIFE-STALE-PASS]
WHEN the current tracked instance is describable in the active AWS account and region, THE devbox domain SHALL continue lifecycle evaluation using the returned live state.

**Postcondition:** Lifecycle behavior proceeds from the observed AWS state.

### Requirement: Bounded Polling [LIFE-ADAPTER-POLL]
WHEN `up` or `down` waits for a target state, THE devbox adapter SHALL poll EC2 state every 5 seconds for no longer than 5 minutes.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Eventual Target State Observed [LIFE-POLL-SUCCESS]
WHEN the target state is observed before the timeout expires, THE devbox adapter SHALL report command success.

**Postcondition:** The command returns after observing the required target state.

#### Scenario: Timeout Reports Last State [LIFE-POLL-TIMEOUT]
IF the target state is not observed within 5 minutes, THEN THE devbox adapter SHALL fail with `TimeoutError` and include the instance ID, expected state, last observed state, and elapsed time.

**Postcondition:** The timeout is visible to the caller and no false success is reported.

#### Scenario: Pending Instance Waits Without Resubmit [LIFE-UP-PENDING]
WHEN the current instance state is `pending`, THE devbox domain SHALL wait for `running` without sending another start request.

**Postcondition:** No redundant start request is submitted and the command succeeds only after observing `running` within the timeout bound.

#### Scenario: Running Instance Succeeds Immediately [LIFE-UP-IDEMPOTENT]
WHEN the current instance state is already `running`, THE devbox domain SHALL succeed immediately without sending a start request or waiting.

**Postcondition:** The command prints the instance ID and exits with code 0.

#### Scenario: Stopping Instance Waits Without Resubmit [LIFE-DOWN-STOPPING]
WHEN the current instance state is `stopping`, THE devbox domain SHALL wait for `stopped` without sending another stop request.

**Postcondition:** No redundant stop request is submitted and the command succeeds only after observing `stopped` within the timeout bound.

#### Scenario: Stopped Instance Succeeds Immediately [LIFE-DOWN-IDEMPOTENT]
WHEN the current instance state is already `stopped`, THE devbox domain SHALL succeed immediately without sending a stop request or waiting.

**Postcondition:** The command prints the instance ID and exits with code 0.

#### Scenario: Signal During Polling Aborts [LIFE-POLL-SIGNAL]
IF SIGINT or SIGTERM is received during EC2 state polling, THEN THE devbox adapter SHALL abort the poll loop immediately without rolling back the already-submitted AWS state transition.

**Postcondition:** The process exits with a non-zero code and does not report false success.
