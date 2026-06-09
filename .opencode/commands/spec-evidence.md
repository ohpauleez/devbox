---
description: Annotate OpenSpec Scenarios with supporting evidence, in the form of links to source code, tests, and executable examples
agent: build
subtask: true
---

As indicated by `docs/lfm.md`, auditable evidence and invariants are central to this project's approach to lightweight formal methods.

Update the spec $1 such that each Scenario has a subsection called Evidence (written as `##### Evidence`) at the end of the Scenario section. If a Scenario already has an Evidence subsection, update and refresh the information.

The Evidence section links each scenario to its implementation, tests, and optionally an executable example that can be mechanically verified by `scripts/evidence.sh`.

Look in these locations first for code and tests before more broadly exploring the code base: $ARGUMENTS
Look at the recent git history to see what other specs, code, or tests should be analyzed and potentially updated.

If a Scenario is not implemented or doesn't have tests, it will not have "Implementation" or "Test" Evidence.

## Evidence format and line types

Each `##### Evidence` section contains a subset of these lines:

- **Implementation:** links to source code that implements the scenario
- **Test:** links to unit tests that verify the scenario
- **Test (property):** links to property-based tests
- **Test (integration):** links to integration tests
- **Example:** an executable code block verified by `scripts/evidence.sh`

Group tests by type. Multiple entries of the same type are comma-separated on one line.

Link format: `[<File>:<Line> <method/function>](/<relative-path>#L<line>)`

## Executable examples

Examples are fenced code blocks that follow `- Example:` inside an Evidence section. The `scripts/evidence.sh` evaluator runs them and checks expectations.

### Supported languages

Language tags:

- `java`
- `javascript` or `js`
- `typescript` or `ts`

### Expectation comments

Inside example code blocks, trailing comments define expectations that are mechanically checked:

| Comment | Meaning |
|---|---|
| `//=> <value>` | Output/result must contain `<value>` |
| `//=> type <TypeName>` | Variable type must match `<TypeName>` |
| `//=> throws <Exception>` | Statement must throw the named exception |
| `//*` | Any non-exception output (statement succeeds) |

Lines without expectation comments are executed but not checked (setup code).

## Evidence examples

### Example: A Scenario with an Evidence block

#### Scenario: Stopped Instance Started [LIFE-UP-START]
WHEN the current instance state is `stopped`, THE devbox domain SHALL send a start request and wait for `running`.

**Postcondition:** The command succeeds only after observing `running` within the timeout bound.

##### Evidence
- Implementation: [InstanceLifecycle.java:88 up(InstanceState)](/src/main/java/com/example/devbox/InstanceLifecycle.java#L88)
- Test: [InstanceLifecycleTest.java:45 up_fromStopped_startsInstance()](/src/test/java/com/example/devbox/InstanceLifecycleTest.java#L45)
- Test (property): [InstanceLifecyclePropertyTest.java:62 up_fromLegalState_reachesRunning()](/src/test/java/com/example/devbox/InstanceLifecyclePropertyTest.java#L62)
- Example:
```java
import com.example.devbox.InstanceLifecycle;
import com.example.devbox.InstanceState;
var lifecycle = InstanceLifecycle.create(InstanceState.STOPPED); //=> type InstanceLifecycle
lifecycle.up(); //*
lifecycle.currentState(); //=> RUNNING
```
### Example: A Scenario with an Evidence block but no tests for the specification

#### Scenario: Invalid Up State Rejected [LIFE-UP-FAIL]
IF the current instance state is `shutting-down` or `terminated`, THEN THE devbox domain SHALL fail with `InstanceStateError` and SHALL NOT send a start request.

**Postcondition:** No invalid lifecycle transition is requested.

##### Evidence
- Implementation: [InstanceLifecycle.java:92 up(InstanceState)](/src/main/java/com/example/devbox/InstanceLifecycle.java#L92)
- Example:
```java
import com.example.devbox.InstanceLifecycle;
import com.example.devbox.InstanceState;
var lifecycle = InstanceLifecycle.create(InstanceState.TERMINATED); //=> type InstanceLifecycle
lifecycle.up(); //=> throws InstanceStateError
```
### Example: A Scenario with an Evidence block, but for a project in TypeScript

#### Scenario: Bracketed identifier is extracted without brackets [TRACE-ID-EXTRACT]
WHEN an included canonical spec file contains a bracketed identifier such as `[BOX-NULL-REJECT]`, THE spec-traceability utility SHALL extract `BOX-NULL-REJECT` as the canonical identifier value.

**Postcondition:** The stored identifier excludes the surrounding brackets.

##### Evidence
- Implementation: [catalog.ts:34 extractIdentifiers()](/src/spec-trace/catalog.ts#L34)
- Test: [catalog.test.ts:18 extracts bracketed identifier without brackets](/src/spec-trace/__tests__/catalog.test.ts#L18)
- Test (property): [catalog.property.test.ts:12 extractIdentifiers_matchesBracketFormat()](/src/spec-trace/__tests__/catalog.property.test.ts#L12)
- Example:
```typescript
const { extractIdentifiers } = await import("./src/spec-trace/catalog.ts");
const ids = extractIdentifiers("### Requirement: Foo [BOX-NULL-REJECT]"); //=> type Array
ids[0]; //=> BOX-NULL-REJECT
ids.length; //=> 1
```

