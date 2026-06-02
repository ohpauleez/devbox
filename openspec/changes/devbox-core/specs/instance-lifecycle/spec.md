## ADDED Requirements

### Requirement: CLI Lifecycle Commands [LIFE-CLI-CMDS]
THE devbox CLI SHALL provide `up` and `down` commands that operate on the current tracked box.

**References:**
- `proposal.md#Scope`
- `proposal.md#Capabilities`

#### Scenario: Current Box Required [LIFE-CURRENT-REQ]
IF the user invokes `up` or `down` and no current box is selected, THEN THE devbox CLI SHALL fail with a normalized error summary.

**Postcondition:** No AWS lifecycle request is sent.

#### Scenario: Lifecycle Success Prints Instance [LIFE-CLI-SUCCESS]
WHEN `up` or `down` succeeds, THE devbox CLI SHALL print the targeted instance ID on stdout.

**Postcondition:** Stdout contains a single-line instance identifier.

### Requirement: Active Context Scoping [LIFE-DOMAIN-SCOPE]
THE devbox domain SHALL evaluate tracked instance state against only the active AWS account and region at command time.

**References:**
- `proposal.md#Scope`
- `proposal.md#Context`

#### Scenario: Active Context Defines Validity [LIFE-SCOPE-ACTIVE]
WHEN a lifecycle command describes the tracked instance, THE devbox domain SHALL use the user's active AWS account and region as the only lookup context.

**Postcondition:** State and existence checks are tied to the active command environment.

#### Scenario: Cross Context Tracking Not Supported [LIFE-SCOPE-FAIL]
IF a tracked instance is not describable in the active AWS account or region, THEN THE devbox domain SHALL treat the box as stale rather than attempting profile or region discovery.

**Postcondition:** The command does not mutate AWS state through guessed alternate contexts.

### Requirement: Up State Machine [LIFE-DOMAIN-UP]
WHEN `up` is invoked, THE devbox domain SHALL accept `stopped`, `pending`, or `running` as legal starting states and SHALL reject `shutting-down` or `terminated`.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Failure Modes`

#### Scenario: Stopped Instance Started [LIFE-UP-START]
WHEN the current instance state is `stopped`, THE devbox domain SHALL send a start request and wait for `running`.

**Postcondition:** The command succeeds only after observing `running` within the timeout bound.

#### Scenario: Invalid Up State Rejected [LIFE-UP-FAIL]
IF the current instance state is `shutting-down` or `terminated`, THEN THE devbox domain SHALL fail with `InstanceStateError` and SHALL NOT send a start request.

**Postcondition:** No invalid lifecycle transition is requested.

### Requirement: Down State Machine [LIFE-DOMAIN-DOWN]
WHEN `down` is invoked, THE devbox domain SHALL accept `running`, `stopping`, or `stopped` as legal starting states and SHALL reject `shutting-down` or `terminated`.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Failure Modes`

#### Scenario: Running Instance Stopped [LIFE-DOWN-STOP]
WHEN the current instance state is `running`, THE devbox domain SHALL send a stop request and wait for `stopped`.

**Postcondition:** The command succeeds only after observing `stopped` within the timeout bound.

#### Scenario: Invalid Down State Rejected [LIFE-DOWN-FAIL]
IF the current instance state is `shutting-down` or `terminated`, THEN THE devbox domain SHALL fail with `InstanceStateError` and SHALL NOT send a stop request.

**Postcondition:** No invalid lifecycle transition is requested.

### Requirement: Stale Resource Handling [LIFE-DOMAIN-STALE]
IF a lifecycle command targets a tracked box whose instance is missing or no longer describable in the active AWS account and region, THEN THE devbox domain SHALL fail with `NotFoundError`.

**References:**
- `proposal.md#Failure Modes`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Stale Instance Rejected [LIFE-STALE-FAIL]
IF the current tracked instance cannot be described in the active AWS account and region, THEN THE devbox domain SHALL reject `up` or `down` without mutating local config.

**Postcondition:** The tracked alias remains present and AWS state is unchanged.

#### Scenario: Live Instance Continues [LIFE-STALE-PASS]
WHEN the current tracked instance is describable in the active AWS account and region, THE devbox domain SHALL continue lifecycle evaluation using the returned live state.

**Postcondition:** Lifecycle behavior proceeds from the observed AWS state.

### Requirement: Bounded Polling [LIFE-ADAPTER-POLL]
WHEN `up` or `down` waits for a target state, THE devbox adapter SHALL poll EC2 state every 5 seconds for no longer than 5 minutes.

**References:**
- `proposal.md#Quality Attributes`
- `proposal.md#Failure Modes`

#### Scenario: Eventual Target State Observed [LIFE-POLL-SUCCESS]
WHEN the target state is observed before the timeout expires, THE devbox adapter SHALL report command success.

**Postcondition:** The command returns after observing the required target state.

#### Scenario: Timeout Reports Last State [LIFE-POLL-TIMEOUT]
IF the target state is not observed within 5 minutes, THEN THE devbox adapter SHALL fail with `TimeoutError` and include the instance ID, expected state, last observed state, and elapsed time.

**Postcondition:** The timeout is visible to the caller and no false success is reported.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
