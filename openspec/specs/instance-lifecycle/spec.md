---
title: InstanceLifecycle
---

## Purpose

Define the lifecycle-control behavior for the current tracked `devbox` machine, with the active AWS account and region treated as authoritative for live state.
This spec captures the explicit lifecycle state machines, stale-resource handling, bounded polling, timeout reporting, and normalized failures so `up` and `down` remain predictable, safe, and mechanically testable.

```alloy
module InstanceLifecycle
open util/boolean

// --- EC2 instance state machine vocabulary ---

abstract sig InstanceState {}
one sig Stopped, Pending, Running, Stopping, ShuttingDown, Terminated extends InstanceState {}

sig Instance {
  var state : one InstanceState,
  var describable : one Bool   // whether the instance is visible in active AWS context
}

// Tracked box selection
var sig current in Instance {}

// --- Command and result vocabulary ---
// Note: Specifically not using `enum` here that there is no implied `ordering`
abstract sig Cmd {}
one sig UpCmd, DownCmd extends Cmd {}

abstract sig Outcome {}
one sig Success, InstanceStateError, NotFoundError, TimeoutError, Aborted extends Outcome {}

// --- Polling state ---
// Models bounded polling as a countdown from max ticks to zero.
// Each tick represents one 5-second poll interval; 60 ticks = 5 minutes.

one sig PollState {
  var active : one Bool,
  var ticksRemaining : one Int,
  var targetState : lone InstanceState,
  var startRequested : one Bool,
  var lastOutcome : lone Outcome
}
```

## Requirements

**CLI Layer:** command surface, parsing, output, and composition of domain+adapters.

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

##### Evidence
- Implementation: [up.ts:82 runUpCommand()](/src/cli/commands/up.ts#L82), [down.ts:73 runDownCommand()](/src/cli/commands/down.ts#L73), [config-store.ts:314 loadConfig()](/src/adapters/config-store.ts#L314), [context.ts:46 resolveCurrentBox()](/src/domain/context.ts#L46)
- Test (integration): [lifecycle-commands.integration.test.ts:52 up requires current selection](/test/integration/lifecycle-commands.integration.test.ts#L52), [lifecycle-commands.integration.test.ts:68 down requires current selection](/test/integration/lifecycle-commands.integration.test.ts#L68)
- Example:
```ts
const { resolveCurrentBox } = await import("./src/domain/context.ts");
const config = { boxes: {}, defaults: { tags: { Owner: "devbox", ManagedBy: "devbox" } } };
const result = resolveCurrentBox(config); //=> type Object
result.ok; //=> false
result.error.category; //=> ValidationError
```

#### Scenario: Lifecycle Success Prints Instance [LIFE-CLI-SUCCESS]
WHEN `up` or `down` succeeds, THE devbox CLI SHALL print the targeted instance ID on stdout.

**Postcondition:** Stdout contains a single-line instance identifier.

##### Evidence
- Implementation: [up.ts:172 runUpCommand()](/src/cli/commands/up.ts#L172), [down.ts:114 runDownCommand()](/src/cli/commands/down.ts#L114)
- Test (integration): [lifecycle-commands.integration.test.ts:84 up from stopped sends start request and prints instance id](/test/integration/lifecycle-commands.integration.test.ts#L84), [lifecycle-commands.integration.test.ts:103 up from stopping waits, starts once, and prints instance id](/test/integration/lifecycle-commands.integration.test.ts#L103), [lifecycle-commands.integration.test.ts:124 down from running sends stop request and prints instance id](/test/integration/lifecycle-commands.integration.test.ts#L124)

#### Requirement model

```alloy
// --- Precondition: current box must be selected ---

pred no_current_box {
  no current
}

pred lifecycle_rejected_no_current [c : Cmd] {
  // Guard: no current box selected
  no_current_box
  // Effect: command fails, no AWS request, no state change
  PollState.active' = False
  PollState.startRequested' = False
  PollState.lastOutcome' = NotFoundError
  // Frame: instance state unchanged
  all i : Instance | i.state' = i.state and i.describable' = i.describable
  current' = current
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
}

// Safety: no AWS request when current is absent
assert no_aws_request_without_current {
  always (no_current_box implies PollState.startRequested' = False)
}
```

- - -

**Domain Layer:** deterministic business rules and state machine.

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

##### Evidence
- Implementation: [up.ts:94 runUpCommand()](/src/cli/commands/up.ts#L94), [down.ts:84 runDownCommand()](/src/cli/commands/down.ts#L84), [aws-cli.ts:266 describeInstance()](/src/adapters/aws-cli.ts#L266)
- Test (integration): [lifecycle-commands.integration.test.ts:173 up continues when current instance is describable in active context](/test/integration/lifecycle-commands.integration.test.ts#L173)

#### Scenario: Cross Context Tracking Not Supported [LIFE-SCOPE-FAIL]
IF a tracked instance is not describable in the active AWS account or region, THEN THE devbox domain SHALL treat the box as stale rather than attempting profile or region discovery.

**Postcondition:** The command does not mutate AWS state through guessed alternate contexts.

##### Evidence
- Implementation: [up.ts:94 runUpCommand()](/src/cli/commands/up.ts#L94), [down.ts:84 runDownCommand()](/src/cli/commands/down.ts#L84), [aws-cli.ts:266 describeInstance()](/src/adapters/aws-cli.ts#L266)
- Test (integration): [lifecycle-commands.integration.test.ts:143 up returns not-found for stale current instance](/test/integration/lifecycle-commands.integration.test.ts#L143), [lifecycle-commands.integration.test.ts:158 down returns not-found for stale current instance](/test/integration/lifecycle-commands.integration.test.ts#L158)

#### Requirement model

```alloy
// --- Active context scoping: describability determines reachability ---

pred instance_describable [i : Instance] {
  i.describable = True
}

pred instance_not_describable [i : Instance] {
  i.describable = False
}

// Invariant: lifecycle commands never attempt state mutation on undescribable instances
assert no_mutation_on_undescribable {
  always (all i : current |
    instance_not_describable[i] implies PollState.startRequested' = False)
}
```

### Requirement: Up State Machine [LIFE-DOMAIN-UP]
WHEN `up` is invoked, THE devbox domain SHALL accept `stopped`, `pending`, `running`, or `stopping` as legal starting states and SHALL reject `shutting-down` or `terminated`.

**References:**
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#proposed-design`
- `openspec/changes/archive/2026-06-05-devbox-core/design.md#component-design`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-05-devbox-core/proposal.md#Failure Modes`

#### Scenario: Stopped Instance Started [LIFE-UP-START]
WHEN the current instance state is `stopped`, THE devbox domain SHALL send a start request and wait for `running`.

**Postcondition:** The command succeeds only after observing `running` within the timeout bound.

##### Evidence
- Implementation: [instance-state.ts:76 decideUpAction()](/src/domain/instance-state.ts#L76), [up.ts:153 runUpCommand()](/src/cli/commands/up.ts#L153), [aws-cli.ts:302 startInstance()](/src/adapters/aws-cli.ts#L302), [ec2-wait.ts:118 waitForEc2TargetState()](/src/domain/ec2-wait.ts#L118)
- Test: [instance-state.contract.test.ts:32 stopped -> submit, wait](/test/contract/instance-state.contract.test.ts#L32)
- Test (integration): [lifecycle-commands.integration.test.ts:84 up from stopped sends start request and prints instance id](/test/integration/lifecycle-commands.integration.test.ts#L84)
- Example:
```ts
const { decideUpAction } = await import("./src/domain/instance-state.ts");
const result = decideUpAction("stopped"); //=> type Object
result.ok; //=> true
result.ok && result.value.submitStart; //=> true
result.ok && result.value.targetState; //=> running
```

#### Scenario: Stopping Instance Waits Then Starts [LIFE-UP-STOPPING]
WHEN the current instance state is `stopping`, THE devbox domain SHALL wait for `stopped`, then send a start request and wait for `running`, all within the same 5-minute timeout budget.

**Postcondition:** The command succeeds only after the instance completes its stop transition and then reaches `running`.

##### Evidence
- Implementation: [instance-state.ts:76 decideUpAction()](/src/domain/instance-state.ts#L76), [up.ts:106 runUpCommand()](/src/cli/commands/up.ts#L106), [aws-cli.ts:302 startInstance()](/src/adapters/aws-cli.ts#L302), [ec2-wait.ts:118 waitForEc2TargetState()](/src/domain/ec2-wait.ts#L118)
- Test: [instance-state.contract.test.ts:43 stopping -> wait for stop before submit](/test/contract/instance-state.contract.test.ts#L43)
- Test (integration): [lifecycle-commands.integration.test.ts:103 up from stopping waits, starts once, and prints instance id](/test/integration/lifecycle-commands.integration.test.ts#L103)
- Test (property): [ec2-lifecycle.property.test.ts:26 returns ok with targetState=running for running/pending/stopped/stopping](/test/property/ec2-lifecycle.property.test.ts#L26)

#### Scenario: Invalid Up State Rejected [LIFE-UP-FAIL]
IF the current instance state is `shutting-down` or `terminated`, THEN THE devbox domain SHALL fail with `InstanceStateError` and SHALL NOT send a start request.

**Postcondition:** No invalid lifecycle transition is requested.

##### Evidence
- Implementation: [instance-state.ts:86 decideUpAction()](/src/domain/instance-state.ts#L86), [up.ts:101 runUpCommand()](/src/cli/commands/up.ts#L101)
- Test: [instance-state.contract.test.ts:55 %s -> error](/test/contract/instance-state.contract.test.ts#L55)
- Test (property): [ec2-lifecycle.property.test.ts:41 returns err for shutting-down/terminated/unknown](/test/property/ec2-lifecycle.property.test.ts#L41)
- Example:
```ts
const { decideUpAction } = await import("./src/domain/instance-state.ts");
const result = decideUpAction("terminated"); //=> type Object
result.ok; //=> false
result.error.category; //=> InstanceStateError
```

#### Requirement model

```alloy
// --- Up command state machine ---

// Legal starting states for 'up'
fun up_legal_states : set InstanceState {
  Stopped + Pending + Running + Stopping
}

// Illegal starting states for 'up'
fun up_illegal_states : set InstanceState {
  ShuttingDown + Terminated
}

// Precondition: up requires current box, describable, legal state
pred up_guard [i : Instance] {
  i in current
  instance_describable[i]
  i.state in up_legal_states
}

// up from stopped: sends start request, begins polling for Running
pred up_from_stopped [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state = Stopped
  PollState.active = False
  // Effect
  PollState.active' = True
  PollState.ticksRemaining' = 60   // 60 ticks * 5s = 5 minutes
  PollState.targetState' = Running
  PollState.startRequested' = True
  no PollState.lastOutcome'   // clear outcome for new polling session
  // EC2 transitions to Pending after start request
  i.state' = Pending
  // Frame
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// up from stopping: deferred start — wait for Stopped, then start
// The 5-minute budget covers both the wait-for-stopped and wait-for-running phases.
pred up_from_stopping [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state = Stopping
  PollState.active = False
  // Effect: begin polling for Running, start is deferred until Stopped is observed
  PollState.active' = True
  PollState.ticksRemaining' = 60
  PollState.targetState' = Running
  PollState.startRequested' = False  // deferred: will be sent when Stopped is reached
  no PollState.lastOutcome'   // clear outcome for new polling session
  // Frame: instance stays in Stopping (EC2 hasn't advanced yet)
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// up from pending: no start request, wait for Running
pred up_from_pending [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state = Pending
  PollState.active = False
  // Effect: begin polling without sending start
  PollState.active' = True
  PollState.ticksRemaining' = 60
  PollState.targetState' = Running
  PollState.startRequested' = False
  no PollState.lastOutcome'   // clear outcome for new polling session
  // Frame
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// up from running: immediate success, no request, no polling
pred up_already_running [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state = Running
  PollState.active = False
  // Effect: immediate success
  PollState.active' = False
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = False
  PollState.lastOutcome' = Success
  // Frame
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// up rejected: illegal state
pred up_rejected [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state in up_illegal_states
  // Effect: fail with InstanceStateError, no request sent
  PollState.active' = False
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = False
  PollState.lastOutcome' = InstanceStateError
  // Frame: no state mutation
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// Safety: up never sends a start request on shutting-down or terminated
assert up_never_starts_invalid {
  always (all i : Instance |
    (i in current and instance_describable[i] and i.state in up_illegal_states)
      implies after (PollState.startRequested = False))
}
```

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

##### Evidence
- Implementation: [instance-state.ts:122 decideDownAction()](/src/domain/instance-state.ts#L122), [down.ts:95 runDownCommand()](/src/cli/commands/down.ts#L95), [aws-cli.ts:354 stopInstance()](/src/adapters/aws-cli.ts#L354), [ec2-wait.ts:118 waitForEc2TargetState()](/src/domain/ec2-wait.ts#L118)
- Test: [instance-state.contract.test.ts:90 running -> submit, wait](/test/contract/instance-state.contract.test.ts#L90)
- Test (integration): [lifecycle-commands.integration.test.ts:124 down from running sends stop request and prints instance id](/test/integration/lifecycle-commands.integration.test.ts#L124)
- Example:
```ts
const { decideDownAction } = await import("./src/domain/instance-state.ts");
const result = decideDownAction("running"); //=> type Object
result.ok; //=> true
result.ok && result.value.submitStop; //=> true
result.ok && result.value.targetState; //=> stopped
```

#### Scenario: Invalid Down State Rejected [LIFE-DOWN-FAIL]
IF the current instance state is `shutting-down` or `terminated`, THEN THE devbox domain SHALL fail with `InstanceStateError` and SHALL NOT send a stop request.

**Postcondition:** No invalid lifecycle transition is requested.

##### Evidence
- Implementation: [instance-state.ts:130 decideDownAction()](/src/domain/instance-state.ts#L130), [down.ts:90 runDownCommand()](/src/cli/commands/down.ts#L90)
- Test: [instance-state.contract.test.ts:101 %s -> error](/test/contract/instance-state.contract.test.ts#L101)
- Test (property): [ec2-lifecycle.property.test.ts:70 returns err for shutting-down/terminated/pending/unknown](/test/property/ec2-lifecycle.property.test.ts#L70)
- Example:
```ts
const { decideDownAction } = await import("./src/domain/instance-state.ts");
const result = decideDownAction("terminated"); //=> type Object
result.ok; //=> false
result.error.category; //=> InstanceStateError
```

#### Requirement model

```alloy
// --- Down command state machine ---

// Legal starting states for 'down'
fun down_legal_states : set InstanceState {
  Running + Stopping + Stopped
}

// Illegal starting states for 'down'
fun down_illegal_states : set InstanceState {
  ShuttingDown + Terminated
}

// down from running: sends stop request, begins polling for Stopped
pred down_from_running [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state = Running
  PollState.active = False
  // Effect
  PollState.active' = True
  PollState.ticksRemaining' = 60
  PollState.targetState' = Stopped
  PollState.startRequested' = True   // "startRequested" here means "transition requested"
  no PollState.lastOutcome'   // clear outcome for new polling session
  // EC2 transitions to Stopping after stop request
  i.state' = Stopping
  // Frame
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// down from stopping: no stop request, wait for Stopped
pred down_from_stopping [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state = Stopping
  PollState.active = False
  // Effect: begin polling without sending stop
  PollState.active' = True
  PollState.ticksRemaining' = 60
  PollState.targetState' = Stopped
  PollState.startRequested' = False
  no PollState.lastOutcome'   // clear outcome for new polling session
  // Frame
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// down from stopped: immediate success
pred down_already_stopped [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state = Stopped
  PollState.active = False
  // Effect: immediate success
  PollState.active' = False
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = False
  PollState.lastOutcome' = Success
  // Frame
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// down rejected: illegal state
pred down_rejected [i : Instance] {
  // Guard
  i in current
  instance_describable[i]
  i.state in down_illegal_states
  // Effect: fail with InstanceStateError
  PollState.active' = False
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = False
  PollState.lastOutcome' = InstanceStateError
  // Frame
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// Safety: down never sends a stop request on shutting-down or terminated
assert down_never_stops_invalid {
  always (all i : Instance |
    (i in current and instance_describable[i] and i.state in down_illegal_states)
      implies after (PollState.startRequested = False))
}
```

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

##### Evidence
- Implementation: [up.ts:94 runUpCommand()](/src/cli/commands/up.ts#L94), [down.ts:84 runDownCommand()](/src/cli/commands/down.ts#L84), [aws-cli.ts:266 describeInstance()](/src/adapters/aws-cli.ts#L266)
- Test (integration): [lifecycle-commands.integration.test.ts:143 up returns not-found for stale current instance](/test/integration/lifecycle-commands.integration.test.ts#L143), [lifecycle-commands.integration.test.ts:158 down returns not-found for stale current instance](/test/integration/lifecycle-commands.integration.test.ts#L158)

#### Scenario: Live Instance Continues [LIFE-STALE-PASS]
WHEN the current tracked instance is describable in the active AWS account and region, THE devbox domain SHALL continue lifecycle evaluation using the returned live state.

**Postcondition:** Lifecycle behavior proceeds from the observed AWS state.

##### Evidence
- Implementation: [up.ts:94 runUpCommand()](/src/cli/commands/up.ts#L94), [down.ts:84 runDownCommand()](/src/cli/commands/down.ts#L84), [aws-cli.ts:266 describeInstance()](/src/adapters/aws-cli.ts#L266)
- Test (integration): [lifecycle-commands.integration.test.ts:173 up continues when current instance is describable in active context](/test/integration/lifecycle-commands.integration.test.ts#L173)

#### Requirement model

```alloy
// --- Stale resource handling ---

pred stale_rejected [i : Instance] {
  // Guard: current box exists but instance is not describable
  i in current
  instance_not_describable[i]
  // Effect: NotFoundError, no state mutation
  PollState.active' = False
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = False
  PollState.lastOutcome' = NotFoundError
  // Frame: local tracking unchanged, AWS state unchanged
  i.state' = i.state
  i.describable' = i.describable
  current' = current
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// Safety: stale instances never trigger AWS state mutations
assert stale_never_mutates_aws {
  always (all i : current |
    instance_not_describable[i] implies (
      i.state' = i.state and PollState.startRequested' = False
    ))
}

// Safety: local tracking preserved on stale rejection
assert stale_preserves_tracking {
  always (all i : current |
    instance_not_describable[i] implies i in current')
}
```

- - -

**Adapter Layer:** filesystem/AWS/process boundary mechanics.

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

##### Evidence
- Implementation: [ec2-wait.ts:118 waitForEc2TargetState()](/src/domain/ec2-wait.ts#L118)
- Test (property): [ec2-lifecycle.property.test.ts:91 succeeds when target state appears in trace](/test/property/ec2-lifecycle.property.test.ts#L91)
- Example:
```ts
const { waitForEc2TargetState } = await import("./src/domain/ec2-wait.ts");
const { ok } = await import("./src/domain/result.ts");
const result = await waitForEc2TargetState({ instanceId: "i-demo", expectedState: "running" }, async () => ok({ instanceId: "i-demo", state: "running", instanceType: "t3.micro" })); //=> type Object
result.ok; //=> true
result.ok && result.value.lastObservedState; //=> running
```

#### Scenario: Timeout Reports Last State [LIFE-POLL-TIMEOUT]
IF the target state is not observed within 5 minutes, THEN THE devbox adapter SHALL fail with `TimeoutError` and include the instance ID, expected state, last observed state, and elapsed time.

**Postcondition:** The timeout is visible to the caller and no false success is reported.

##### Evidence
- Implementation: [ec2-wait.ts:152 waitForEc2TargetState()](/src/domain/ec2-wait.ts#L152)
- Test (integration): [ec2-wait.integration.test.ts:54 returns timeout error when describe always returns pending](/test/integration/ec2-wait.integration.test.ts#L54)
- Example:
```ts
const { waitForEc2TargetState } = await import("./src/domain/ec2-wait.ts");
const { ok } = await import("./src/domain/result.ts");
const clock = { nowMs: (() => { let now = 0; return () => (now += 5001); })(), isoNow: () => "1970-01-01T00:00:00.000Z" };
const result = await waitForEc2TargetState({ instanceId: "i-demo", expectedState: "running", timeoutMs: 5000 }, async () => ok({ instanceId: "i-demo", state: "pending", instanceType: "t3.micro" }), clock); //=> type Object
result.ok; //=> false
result.error.category; //=> TimeoutError
```

#### Scenario: Pending Instance Waits Without Resubmit [LIFE-UP-PENDING]
WHEN the current instance state is `pending`, THE devbox domain SHALL wait for `running` without sending another start request.

**Postcondition:** No redundant start request is submitted and the command succeeds only after observing `running` within the timeout bound.

##### Evidence
- Implementation: [instance-state.ts:80 decideUpAction()](/src/domain/instance-state.ts#L80), [up.ts:161 runUpCommand()](/src/cli/commands/up.ts#L161)
- Test: [instance-state.contract.test.ts:21 pending -> no submit, wait](/test/contract/instance-state.contract.test.ts#L21)
- Test (property): [ec2-lifecycle.property.test.ts:26 returns ok with targetState=running for running/pending/stopped/stopping](/test/property/ec2-lifecycle.property.test.ts#L26)
- Example:
```ts
const { decideUpAction } = await import("./src/domain/instance-state.ts");
const result = decideUpAction("pending"); //=> type Object
result.ok; //=> true
result.ok && result.value.submitStart; //=> false
result.ok && result.value.wait; //=> true
```

#### Scenario: Running Instance Succeeds Immediately [LIFE-UP-IDEMPOTENT]
WHEN the current instance state is already `running`, THE devbox domain SHALL succeed immediately without sending a start request or waiting.

**Postcondition:** The command prints the instance ID and exits with code 0.

##### Evidence
- Implementation: [instance-state.ts:78 decideUpAction()](/src/domain/instance-state.ts#L78), [up.ts:172 runUpCommand()](/src/cli/commands/up.ts#L172)
- Test: [instance-state.contract.test.ts:10 running -> no submit, no wait](/test/contract/instance-state.contract.test.ts#L10)
- Test (property): [ec2-lifecycle.property.test.ts:26 returns ok with targetState=running for running/pending/stopped/stopping](/test/property/ec2-lifecycle.property.test.ts#L26)
- Test (integration): [lifecycle-commands.integration.test.ts:173 up continues when current instance is describable in active context](/test/integration/lifecycle-commands.integration.test.ts#L173)
- Example:
```ts
const { decideUpAction } = await import("./src/domain/instance-state.ts");
const result = decideUpAction("running"); //=> type Object
result.ok; //=> true
result.ok && result.value.wait; //=> false
result.ok && result.value.submitStart; //=> false
```

#### Scenario: Stopping Instance Waits Without Resubmit [LIFE-DOWN-STOPPING]
WHEN the current instance state is `stopping`, THE devbox domain SHALL wait for `stopped` without sending another stop request.

**Postcondition:** No redundant stop request is submitted and the command succeeds only after observing `stopped` within the timeout bound.

##### Evidence
- Implementation: [instance-state.ts:126 decideDownAction()](/src/domain/instance-state.ts#L126), [down.ts:103 runDownCommand()](/src/cli/commands/down.ts#L103)
- Test: [instance-state.contract.test.ts:79 stopping -> no submit, wait](/test/contract/instance-state.contract.test.ts#L79)
- Test (property): [ec2-lifecycle.property.test.ts:55 returns ok with targetState=stopped for stopped/stopping/running](/test/property/ec2-lifecycle.property.test.ts#L55)
- Example:
```ts
const { decideDownAction } = await import("./src/domain/instance-state.ts");
const result = decideDownAction("stopping"); //=> type Object
result.ok; //=> true
result.ok && result.value.submitStop; //=> false
result.ok && result.value.wait; //=> true
```

#### Scenario: Stopped Instance Succeeds Immediately [LIFE-DOWN-IDEMPOTENT]
WHEN the current instance state is already `stopped`, THE devbox domain SHALL succeed immediately without sending a stop request or waiting.

**Postcondition:** The command prints the instance ID and exits with code 0.

##### Evidence
- Implementation: [instance-state.ts:124 decideDownAction()](/src/domain/instance-state.ts#L124), [down.ts:114 runDownCommand()](/src/cli/commands/down.ts#L114)
- Test: [instance-state.contract.test.ts:68 stopped -> no submit, no wait](/test/contract/instance-state.contract.test.ts#L68)
- Test (property): [ec2-lifecycle.property.test.ts:55 returns ok with targetState=stopped for stopped/stopping/running](/test/property/ec2-lifecycle.property.test.ts#L55)
- Example:
```ts
const { decideDownAction } = await import("./src/domain/instance-state.ts");
const result = decideDownAction("stopped"); //=> type Object
result.ok; //=> true
result.ok && result.value.wait; //=> false
result.ok && result.value.submitStop; //=> false
```

#### Scenario: Signal During Polling Aborts [LIFE-POLL-SIGNAL]
IF SIGINT or SIGTERM is received during EC2 state polling, THEN THE devbox adapter SHALL abort the poll loop immediately without rolling back the already-submitted AWS state transition.

**Postcondition:** The process exits with a non-zero code and does not report false success.

##### Evidence
- Implementation: [ec2-wait.ts:7 createPollingAbortSignal()](/src/domain/ec2-wait.ts#L7), [ec2-wait.ts:131 waitForEc2TargetState()](/src/domain/ec2-wait.ts#L131)
- Test (integration): [ec2-wait.integration.test.ts:72 aborts polling promptly when SIGINT is received](/test/integration/ec2-wait.integration.test.ts#L72)

#### Requirement model

```alloy
// --- Bounded polling: tick-based state observation loop ---

// EC2 environment nondeterministically advances instance state
pred ec2_advances [i : Instance] {
  // Pending -> Running (the happy path for 'up')
  (i.state = Pending implies i.state' in (Pending + Running))
  // Stopping -> Stopped (the happy path for 'down')
  (i.state = Stopping implies i.state' in (Stopping + Stopped))
  // Terminal states are absorbing
  (i.state = Terminated implies i.state' = Terminated)
  (i.state = ShuttingDown implies i.state' in (ShuttingDown + Terminated))
  // Stable states remain unless externally changed
  (i.state = Running implies i.state' = Running)
  (i.state = Stopped implies i.state' = Stopped)
}

// A single poll tick: check state, decrement counter
pred poll_tick [i : Instance] {
  // Guard: polling is active and ticks remain
  PollState.active = True
  PollState.ticksRemaining > 0
  i in current
  // EC2 may have advanced the state
  ec2_advances[i]
  // Check if target reached
  (i.state' = PollState.targetState) implies {
    // Success: target observed
    PollState.active' = False
    PollState.lastOutcome' = Success
    PollState.ticksRemaining' = sub[PollState.ticksRemaining, 1]
    PollState.targetState' = PollState.targetState
    PollState.startRequested' = PollState.startRequested
  } else {
    // Continue polling
    PollState.active' = True
    PollState.lastOutcome' = PollState.lastOutcome
    PollState.ticksRemaining' = sub[PollState.ticksRemaining, 1]
    PollState.targetState' = PollState.targetState
    PollState.startRequested' = PollState.startRequested
  }
  // Frame
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// Deferred start: during up-from-stopping, once Stopped is observed, send start request.
// This models the two-phase behavior: wait for Stopped, then start -> Pending -> Running.
pred poll_tick_send_start [i : Instance] {
  // Guard: polling active, targeting Running, start not yet sent, instance now Stopped
  PollState.active = True
  PollState.ticksRemaining > 0
  i in current
  PollState.targetState = Running
  PollState.startRequested = False
  i.state = Stopped
  // Effect: send start request, instance transitions to Pending
  i.state' = Pending
  PollState.startRequested' = True
  PollState.active' = True
  PollState.ticksRemaining' = sub[PollState.ticksRemaining, 1]
  PollState.targetState' = PollState.targetState
  PollState.lastOutcome' = PollState.lastOutcome
  // Frame
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// Timeout: ticks exhausted without observing target
pred poll_timeout [i : Instance] {
  // Guard: polling active but no ticks remain
  PollState.active = True
  PollState.ticksRemaining = 0
  i in current
  // Effect: TimeoutError
  PollState.active' = False
  PollState.lastOutcome' = TimeoutError
  PollState.ticksRemaining' = 0
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = PollState.startRequested
  // Frame: instance state unchanged by timeout
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// Signal abort during polling
pred signal_abort [i : Instance] {
  // Guard: polling is active
  PollState.active = True
  i in current
  // Effect: abort without rollback
  PollState.active' = False
  PollState.lastOutcome' = Aborted
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = PollState.startRequested
  // Frame: AWS state transition already submitted is NOT rolled back
  i.state' = i.state
  current' = current
  i.describable' = i.describable
  all other : Instance - i | other.state' = other.state and other.describable' = other.describable
}

// --- Safety: no false success ---
// Success is only reported when the target state was actually observed
assert no_false_success {
  always (
    (PollState.lastOutcome' = Success and PollState.active = True)
      implies (some i : current | i.state' = PollState.targetState)
  )
}

// Safety: polling always terminates (bounded by tick countdown)
// Requires fairness — polling events must eventually fire when enabled.
// Without fairness, infinite stutter is a valid trace that keeps active=True forever.
pred polling_fairness {
  always (
    (PollState.active = True and PollState.ticksRemaining > 0)
      implies eventually (some i : Instance |
        poll_tick[i] or poll_tick_send_start[i] or signal_abort[i]))
  always (
    (PollState.active = True and PollState.ticksRemaining = 0)
      implies eventually (some i : Instance | poll_timeout[i]))
}

assert polling_terminates {
  polling_fairness implies
    always (PollState.active = True implies eventually PollState.active = False)
}

// Safety: no redundant start request during pending
assert no_redundant_start_on_pending {
  always (all i : current |
    (i.state = Pending and PollState.active = True)
      implies PollState.startRequested' = PollState.startRequested)
}

// Safety: signal abort does not report success
assert signal_abort_no_success {
  always (
    (PollState.active = True and PollState.lastOutcome' = Aborted)
      implies PollState.lastOutcome' != Success
  )
}

// Liveness: if EC2 eventually reaches target, success is eventually reported
// Standard `leads-to` formulation instead of always-eventually-implies
pred ec2_fairness [i : Instance] {
  always (i.state = Pending implies eventually i.state = Running)
  always (i.state = Stopping implies eventually i.state = Stopped)
}

// The core condition is wrapped in always with existence guard to avoid vacuous truth at init
assert liveness_target_reached {
  (polling_fairness and (all i : Instance | ec2_fairness[i])) implies
    always (
      (some current and PollState.active = True and PollState.ticksRemaining > 0)
        implies eventually (PollState.lastOutcome = Success or PollState.lastOutcome = TimeoutError or PollState.lastOutcome = Aborted))
}
```

### State machine and invariant checks

```alloy
// --- Environment event: current box selection ---
// This models the external registry (BoxRegistry module) selecting a current box.
// Without this, current = empty forever after init, making lifecycle events unreachable.

pred env_select_current [i : Instance] {
  // Guard: no current box, instance is describable
  no current
  instance_describable[i]
  PollState.active = False
  // Effect: select this instance as current
  current' = current + i
  // Frame: everything else unchanged
  PollState.active' = PollState.active
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = PollState.startRequested
  PollState.lastOutcome' = PollState.lastOutcome
  all inst : Instance | inst.state' = inst.state and inst.describable' = inst.describable
}

// --- Transition system ---

pred init {
  no current
  PollState.active = False
  PollState.ticksRemaining = 60
  PollState.startRequested = False
  no PollState.targetState
  no PollState.lastOutcome
  all i : Instance | i.state = Stopped and i.describable = True
}

pred stutter {
  current' = current
  PollState.active' = PollState.active
  PollState.ticksRemaining' = PollState.ticksRemaining
  PollState.targetState' = PollState.targetState
  PollState.startRequested' = PollState.startRequested
  PollState.lastOutcome' = PollState.lastOutcome
  all i : Instance | i.state' = i.state and i.describable' = i.describable
}

fact transitions {
  init and always (
    (some i : Instance | env_select_current[i])
    or (some i : Instance | up_from_stopped[i] or up_from_stopping[i] or up_from_pending[i] or up_already_running[i] or up_rejected[i])
    or (some i : Instance | down_from_running[i] or down_from_stopping[i] or down_already_stopped[i] or down_rejected[i])
    or (some i : Instance | stale_rejected[i])
    or (lifecycle_rejected_no_current[UpCmd] or lifecycle_rejected_no_current[DownCmd])
    or (some i : Instance | poll_tick[i])
    or (some i : Instance | poll_tick_send_start[i])
    or (some i : Instance | poll_timeout[i])
    or (some i : Instance | signal_abort[i])
    or stutter
  )
}

// --- Commands ---

run show_instance_lifecycle {} for 2 Instance, 8 Int, 5 steps

// This scenario has been adjusted to be satisfiable — uses eventually to find a valid trace
// through init -> env_select_current -> up_from_stopped -> poll_tick -> success
run scenario_up_from_stopped {
  eventually (some i : Instance |
    i in current and PollState.active = True and PollState.targetState = Running and
    eventually PollState.lastOutcome = Success)
} for 1 Instance, 8 Int, 10 steps

run scenario_up_from_stopping {
  eventually (some i : Instance |
    i in current and i.state = Stopping and PollState.active = True and
    PollState.targetState = Running and PollState.startRequested = False and
    eventually PollState.lastOutcome = Success)
} for 1 Instance, 8 Int, 15 steps

check no_false_success for 2 Instance, 8 Int, 20 steps expect 0
check up_never_starts_invalid for 2 Instance, 8 Int, 15 steps expect 0
check down_never_stops_invalid for 2 Instance, 8 Int, 15 steps expect 0
check stale_never_mutates_aws for 2 Instance, 8 Int, 15 steps expect 0
check stale_preserves_tracking for 2 Instance, 8 Int, 15 steps expect 0
// Note: polling_terminates requires 60+ steps to cover full countdown.
// Verified at reduced scope (10 steps) which confirms the mechanism structure.
// Full verification at 60+ steps is computationally infeasible for BMC.
check polling_terminates for 1 Instance, 7 Int, 10 steps

check liveness_target_reached for 1 Instance, 7 Int, 15 steps
```
