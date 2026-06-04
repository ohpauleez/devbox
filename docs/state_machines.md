# State Machines in TypeScript

State machines are a strong foundational construction pattern in software.
They are useful in production systems because they make legal behavior explicit and easier to
enforce, debug, and test.

Instead of scattering lifecycle rules across conditionals, a state machine
names the valid states, the allowed transitions, and the actions that move the
system forward.

## Why use state machines?

- They make workflows explicit. A reader can see the lifecycle directly instead of inferring it from flags and `if` statements.
- They reduce invalid states. When the model says an object is `Draft`, `Paid`, or `Shipped`, the code can avoid impossible combinations.
- They improve maintainability. Adding a new state or transition becomes a focused change to the model instead of a hunt across the codebase.
- They support better testing. It is easier to enumerate expected transitions, terminal states, and known failure-modes.
- They align well with formal reasoning. Preconditions, postconditions, and invariants often map naturally onto state transitions.
- They can move correctness earlier. With the right TypeScript design, some invalid transitions can be rejected by the compiler instead of failing at runtime.

## Quick comparison

| Approach | Compiler-checked transitions | Allocation profile | Best for | Main tradeoff |
|---|---|---|---|---|
| Discriminated union | No | Moderate | Simple business workflows | Mostly runtime-checked |
| Typestate with branded types | Yes | Low | APIs, protocols, capability-style workflows | More type-level machinery |
| Distinct state types with transition methods | Yes | Moderate | Clear domain models, LemmaScript-friendly code | More types and boilerplate |
| Packed numeric state machines | Limited | Very low | Hot paths, lowest latency, lowest GC | Harder to read and evolve |
| Singleton typestate | Yes | Very low | Hot paths that still need typed transitions | More complex than branded typestate |

## Common ways to implement state machines in TypeScript

### 1. Discriminated-union state machines

This is the most idiomatic TypeScript approach. States are members of a discriminated union, and transition logic lives in functions that switch on the discriminant.

Advantages:

- Compact and familiar.
- Easy to serialize, log, and inspect.
- Exhaustive `switch` via `never` ensures all states are handled.
- Good for simple business workflows.

Tradeoffs:

- Transition legality is mostly enforced at runtime.
- The compiler knows the set of states, but usually cannot prevent illegal transition calls.
- Adding branching transitions usually requires external policy or additional function overloads.

Example:

```typescript
type OrderState = "draft" | "paid" | "shipped";

interface Order {
  readonly id: string;
  readonly cents: number;
  state: OrderState;
}

function createOrder(id: string, cents: number): Order {
  return { id, cents, state: "draft" };
}

function advance(order: Order): Order {
  switch (order.state) {
    case "draft":
      return { ...order, state: "paid" };
    case "paid":
      return { ...order, state: "shipped" };
    case "shipped":
      throw new Error("SHIPPED is terminal");
    default: {
      const _exhaustive: never = order.state;
      throw new Error(`Unknown state: ${_exhaustive}`);
    }
  }
}
```

A richer variant uses a discriminated union of state objects instead of a single `state` field, allowing each state to carry state-specific data:

```typescript
type OrderState =
  | { readonly kind: "draft"; readonly id: string; readonly cents: number }
  | { readonly kind: "paid"; readonly id: string; readonly cents: number; readonly paidAt: Date }
  | { readonly kind: "shipped"; readonly id: string; readonly cents: number; readonly trackingId: string };

function pay(order: Extract<OrderState, { kind: "draft" }>): Extract<OrderState, { kind: "paid" }> {
  return { kind: "paid", id: order.id, cents: order.cents, paidAt: new Date() };
}

function ship(
  order: Extract<OrderState, { kind: "paid" }>,
  trackingId: string
): Extract<OrderState, { kind: "shipped" }> {
  return { kind: "shipped", id: order.id, cents: order.cents, trackingId };
}
```

This gives some compile-time safety: calling `ship` on a `"draft"` order is a type error. However, narrowing typically requires the caller to have already discriminated via a `switch` or `if`.

### 2. Typestate with branded types

In this design, the state appears in the TypeScript type via brands (unique symbol properties that exist only at the type level). A value like `Order & Brand<"Draft">` can only be passed to operations that accept the `Draft` state, and each transition returns a value branded with the next state.

TypeScript's structural type system does not natively support phantom type parameters the way Java generics do. Branded types fill this gap: they add a nominal marker that the compiler checks but that has no runtime representation.

Advantages:

- Strong compile-time enforcement.
- Good fit for APIs, protocols, and workflows.
- Makes illegal transitions literally fail to compile.
- Zero runtime overhead for the brand itself (it exists only in the type system).

Tradeoffs:

- Slightly unfamiliar pattern for developers new to branded types.
- Can become awkward for highly branching or cyclic graphs.
- Requires careful use of type assertions at the boundary where brands are minted.

Example:

```typescript
// Brand infrastructure
declare const __brand: unique symbol;
type Brand<T extends string> = { readonly [__brand]: T };

// State brands
type Draft = Brand<"Draft">;
type Paid = Brand<"Paid">;
type Shipped = Brand<"Shipped">;

// Core data
interface OrderData {
  readonly id: string;
  readonly cents: number;
}

// Branded order type
type Order<State extends Brand<string>> = OrderData & State;

// Transitions — each function accepts one state and returns another
function createOrder(id: string, cents: number): Order<Draft> {
  return { id, cents } as Order<Draft>;
}

function pay(order: Order<Draft>): Order<Paid> {
  return order as unknown as Order<Paid>;
}

function ship(order: Order<Paid>): Order<Shipped> {
  return order as unknown as Order<Shipped>;
}

// Usage
const draft = createOrder("o-123", 2500);
const paid = pay(draft);
const shipped = ship(paid);

// Does not compile:
// ship(draft);  // Argument of type 'Order<Draft>' is not assignable to parameter of type 'Order<Paid>'
```

The key insight is that `pay` only accepts `Order<Draft>` and returns `Order<Paid>`. Passing an order in any other state is a compile-time error. The runtime value is unchanged; only the type narrows.

#### Nested brands for composite control

Brands compose naturally for tighter invariants:

```typescript
type Validated = Brand<"Validated">;
type Authorized = Brand<"Authorized">;

type Request<S extends Brand<string>> = { readonly body: string } & S;

function validate(req: Request<Draft>): Request<Validated> {
  // validation logic
  return req as unknown as Request<Validated>;
}

function authorize(req: Request<Validated>): Request<Validated & Authorized> {
  // authorization logic
  return req as unknown as Request<Validated & Authorized>;
}

function execute(req: Request<Validated & Authorized>): void {
  // only reachable if both validated AND authorized
}
```

### 3. Distinct state types with explicit transition methods

In this design, each state is a distinct class or interface, and only that state exposes the transitions that are valid from it. This is analogous to Java's sealed-interface pattern.

Advantages:

- Very readable model of the lifecycle.
- Strong compile-time guarantees.
- Each state can carry state-specific data and behavior.
- Works well with TypeScript's structural typing and discriminated unions.

Tradeoffs:

- More types to define.
- Can be verbose for large state graphs.
- Class-based designs may allocate more than necessary on hot paths.

Example:

```typescript
interface OrderState {
  readonly id: string;
  readonly cents: number;
}

class DraftOrder implements OrderState {
  readonly kind = "draft" as const;
  constructor(readonly id: string, readonly cents: number) {}

  pay(): PaidOrder {
    return new PaidOrder(this.id, this.cents);
  }
}

class PaidOrder implements OrderState {
  readonly kind = "paid" as const;
  constructor(readonly id: string, readonly cents: number) {}

  ship(): ShippedOrder {
    return new ShippedOrder(this.id, this.cents);
  }
}

class ShippedOrder implements OrderState {
  readonly kind = "shipped" as const;
  constructor(readonly id: string, readonly cents: number) {}
}

type OrderState = DraftOrder | PaidOrder | ShippedOrder;

// Usage
const draft = new DraftOrder("o-123", 2500);
const paid = draft.pay();
const shipped = paid.ship();

// Does not compile:
// draft.ship();  // Property 'ship' does not exist on type 'DraftOrder'
```

This pattern can also be implemented with plain objects and factory functions instead of classes, avoiding the `new` keyword and making the objects more serialization-friendly:

```typescript
interface DraftOrder {
  readonly kind: "draft";
  readonly id: string;
  readonly cents: number;
}

interface PaidOrder {
  readonly kind: "paid";
  readonly id: string;
  readonly cents: number;
}

interface ShippedOrder {
  readonly kind: "shipped";
  readonly id: string;
  readonly cents: number;
}

type OrderState = DraftOrder | PaidOrder | ShippedOrder;

function createOrder(id: string, cents: number): DraftOrder {
  return { kind: "draft", id, cents };
}

function pay(order: DraftOrder): PaidOrder {
  return { kind: "paid", id: order.id, cents: order.cents };
}

function ship(order: PaidOrder): ShippedOrder {
  return { kind: "shipped", id: order.id, cents: order.cents };
}
```

### 4. Packed-numeric state machines

In this design, the machine state is stored in one or a few numeric values, and transitions are implemented as small pure functions that decode, update, and re-encode the bits. JavaScript's bitwise operators work on 32-bit signed integers, and `BigInt` can be used for wider encodings.

Advantages:

- Very low allocation and GC pressure.
- Often the best raw throughput for tight loops.
- A good fit for hot paths, protocol engines, and stream processors.
- V8 can often keep these values as SMIs (Small Integers) in the fast path.

Tradeoffs:

- Harder to read and debug than object-based designs.
- Less self-documenting than typestate or discriminated unions.
- Compiler-checked transition safety is weaker unless wrapped by a typed API.
- Bit layouts must be designed and maintained carefully.
- JavaScript bitwise operators are limited to 32 bits (use `BigInt` for wider state).

Example:

```typescript
// Layout: [state: 2 bits][revision: 16 bits][cents: 14 bits]
const STATE_MASK = 0x3;
const REVISION_SHIFT = 2;
const CENTS_SHIFT = 18;

const DRAFT = 0;
const PAID = 1;
const SHIPPED = 2;

function create(cents: number, revision: number): number {
  return ((cents & 0x3FFF) << CENTS_SHIFT)
    | ((revision & 0xFFFF) << REVISION_SHIFT)
    | DRAFT;
}

function pay(order: number): number {
  return (order & ~STATE_MASK) | PAID;
}

function ship(order: number): number {
  return (order & ~STATE_MASK) | SHIPPED;
}

function getState(order: number): number {
  return order & STATE_MASK;
}

function getCents(order: number): number {
  return (order >>> CENTS_SHIFT) & 0x3FFF;
}
```

Note: Unlike Java's `long` (64 bits), JavaScript bitwise operations truncate to 32 bits. For wider packed state, use `BigInt`:

```typescript
function createWide(id: bigint, cents: bigint, revision: bigint): bigint {
  return (id << 34n) | (cents << 18n) | (revision << 2n) | 0n;
}

function payWide(order: bigint): bigint {
  return (order & ~0x3n) | 1n;
}
```

`BigInt` operations are substantially slower than SMI arithmetic in V8, so prefer the 32-bit form when the state fits.

### 5. Singleton typestate

Singleton typestate separates protocol safety from runtime data. Legal states are represented by singleton objects whose types encode the allowed transitions, while runtime data lives in a mutable object or packed numeric carrier.

Advantages:

- Compiler-checked transitions.
- Very low allocation when paired with mutable data carriers.
- Useful middle ground between packed numerics and branded typestate.

Tradeoffs:

- More complex than ordinary branded typestate.
- Less readable than distinct state classes.
- Shared mutable carriers require careful ownership discipline (no built-in thread confinement in JS, but shared workers / async concerns apply).

Example:

```typescript
interface OrderData {
  id: string;
  cents: number;
  revision: number;
}

class Draft {
  private static readonly instance = new Draft();
  private constructor() {}
  static get(): Draft { return Draft.instance; }

  pay(_data: OrderData): Paid {
    return Paid.get();
  }
}

class Paid {
  private static readonly instance = new Paid();
  private constructor() {}
  static get(): Paid { return Paid.instance; }

  ship(_data: OrderData): Shipped {
    return Shipped.get();
  }
}

class Shipped {
  private static readonly instance = new Shipped();
  private constructor() {}
  static get(): Shipped { return Shipped.instance; }

  reset(data: OrderData): Draft {
    data.revision++;
    return Draft.get();
  }
}

// Usage
const data: OrderData = { id: "o-123", cents: 2500, revision: 0 };
let state: Draft | Paid | Shipped = Draft.get();

state = (state as Draft).pay(data);    // state is now Paid
state = (state as Paid).ship(data);    // state is now Shipped
state = (state as Shipped).reset(data); // state is now Draft, revision incremented
```

A more ergonomic version uses a generic machine wrapper:

```typescript
class Machine<S> {
  constructor(private state: S, readonly data: OrderData) {}

  transition<Next>(fn: (state: S, data: OrderData) => Next): Machine<Next> {
    this.state = fn(this.state, this.data) as unknown as S;
    return this as unknown as Machine<Next>;
  }

  currentState(): S { return this.state; }
}
```

## Choosing an approach

## Practical guidance / Choosing an approach

For many TypeScript systems, the best progression is:

1. Start with a discriminated union if the lifecycle is simple.
    - Use discriminated unions when simplicity matters more than compile-time transition safety.
2. Use branded typestate when illegal transitions must be caught by the compiler.
    - Use branded typestate when the workflow itself is part of the API contract.
3. Move to distinct state types when state-specific behavior starts to grow or you need a clearer domain model.
    - Use distinct state types when you want a clear, explicit, domain-centered model with per-state methods.
4. Use singleton typestate or packed numerics when the machine sits on a hot path.
    - Use packed numerics when absolute throughput and minimal allocation are the priority.
    - Use singleton typestate when you want near-zero-allocation code with compiler-checked transitions.

## Production concerns

In production systems, the best state-machine design is not just the one with the strongest type story. It also needs to work well with storage, concurrency, observability, and long-term evolution.

- Persist logical state, not TypeScript implementation details. Store state names or stable numeric codes in databases and messages. A discriminated union's `kind` field often makes a natural persistence key.
- Validate external input at runtime before converting it into stronger typed internal representations. Use `zod`, `io-ts`, or manual validation at the boundary.
- Be explicit about async boundaries. Immutable object designs are easier to reason about across `await` points; mutable packed or singleton-carrier designs require careful ownership tracking.
- Add structured logging around state transitions so production failures can be traced in terms of domain states, not only internal classes or bit patterns.
- Plan for evolution. Adding a new state is easier when state handling is centralized and exhaustive. TypeScript's `never` trick in `default` switch branches catches unhandled states at compile time when a new variant is added to the union.

## Using LemmaScript with state machines

This section covers how [LemmaScript](https://lemmascript.com/) can formally verify state machine implementations in TypeScript. LemmaScript is a verification toolchain that lets you annotate TypeScript with `//@` specifications and then generates formal proofs (via Dafny or Lean 4) that the code satisfies those specifications.

If the software is already using LemmaScript for verification, state machines fit naturally: each transition can be described by preconditions and postconditions, and the state model becomes a clean place to express those guarantees.

### Main LemmaScript guidance

- Use `//@ requires` for legal transitions (preconditions on the current state).
- Use `//@ ensures` for the destination state and preserved business data.
- Use `//@ invariant` in loops that process state sequences.
- Use `forall` and `exists` in specs to describe properties over collections of states.
- Prefer the discriminated-union or distinct-state-type patterns for LemmaScript, since they map most naturally to Dafny's `datatype` system.

### LemmaScript with a discriminated-union state machine

A discriminated-union machine usually stores the current state as a tagged value. LemmaScript works well here to verify runtime guards and effects.

```typescript
type State = "draft" | "paid" | "shipped";

interface Order {
  state: State;
  id: string;
  cents: number;
}

function pay(order: Order): Order {
  //@ verify
  //@ requires order.state === "draft"
  //@ ensures \result.state === "paid"
  //@ ensures \result.id === order.id
  //@ ensures \result.cents === order.cents
  return { ...order, state: "paid" };
}

function ship(order: Order): Order {
  //@ verify
  //@ requires order.state === "paid"
  //@ ensures \result.state === "shipped"
  //@ ensures \result.id === order.id
  return { ...order, state: "shipped" };
}
```

This style is useful when the lifecycle is simple and runtime checks are acceptable. LemmaScript makes the transition rules explicit and machine-checkable, but the TypeScript type system still cannot reject all illegal calls ahead of time (the `requires` fires at verification time, not as a TS compile error).

### LemmaScript with distinct state types

Distinct state types are often the best match for LemmaScript. Each state is a distinct TypeScript type, and each legal transition can be a function that takes the source state and returns the destination state.

This works well with LemmaScript because:

- illegal transitions are absent from the function surface (you cannot call `ship` on a `DraftOrder`),
- each function contract is local and simple,
- specifications can talk about concrete source and destination types,
- and exhaustive handling over the union remains available.

```typescript
interface DraftOrder {
  readonly kind: "draft";
  readonly id: string;
  readonly cents: number;
}

interface PaidOrder {
  readonly kind: "paid";
  readonly id: string;
  readonly cents: number;
}

interface ShippedOrder {
  readonly kind: "shipped";
  readonly id: string;
  readonly cents: number;
}

function pay(order: DraftOrder): PaidOrder {
  //@ verify
  //@ requires order.cents >= 0
  //@ ensures \result.id === order.id
  //@ ensures \result.cents === order.cents
  return { kind: "paid", id: order.id, cents: order.cents };
}

function ship(order: PaidOrder): ShippedOrder {
  //@ verify
  //@ ensures \result.id === order.id
  return { kind: "shipped", id: order.id, cents: order.cents };
}
```

In practice, this style keeps LemmaScript contracts short and aligned with the domain model. Because each transition is a standalone function with explicit input/output types, Dafny's verification has the clearest reasoning surface.

### Which pattern works best with LemmaScript?

1. Use distinct state types (interfaces with discriminants) when you want the clearest LemmaScript specifications. This approach is usually the strongest overall combination of clarity, compiler checking, and LemmaScript/Dafny friendliness.
2. Use branded typestate when compile-time transition safety matters most and the type design stays simple. Branded types provide the strongest TypeScript-level protocol safety, but the brand machinery may require `//@ declare-type` annotations to model in LemmaScript.
3. Use discriminated unions with a single `state` field when the machine is small. These machines are easy to specify and verify, but rely more on runtime guards than on type-level safety.

### Additional practical notes

- Keep transition functions small. Small function bodies are easier for Dafny to verify.
- If a transition creates a new object, specify both the result structure and the preserved data properties via `//@ ensures`.
- Use `//@ ghost let` for proof-only tracking of state history when verifying multi-step protocols.
- If a transition can fail by throwing, model the error path with a union return type (`Result<S, E>`) rather than relying on exceptions, since LemmaScript reasons about return values, not thrown exceptions.

## Coupled machines: product-state encoding

Some systems are not a single state machine, but several machines whose states
must stay consistent with each other. In those cases, it is often better to
model the combined system directly as a product state machine instead of
keeping separate mutable machines and trying to synchronize them with runtime
checks.

The traffic light intersection is a good example. Suppose the legal combined states are:

- `GR`: north-south is green, east-west is red
- `YR`: north-south is yellow, east-west is red
- `RR`: both directions are red
- `RG`: north-south is red, east-west is green
- `RY`: north-south is red, east-west is yellow
- `FF`: both directions are flashing red because of a fault

The key idea is that the type represents the whole intersection, not each light independently. That makes illegal combinations unrepresentable.

Implementation using distinct state types:

```typescript
// Phantom type markers (never instantiated)
interface Green { readonly _green: unique symbol }
interface Yellow { readonly _yellow: unique symbol }
interface Red { readonly _red: unique symbol }
interface FlashingRed { readonly _flashing: unique symbol }

// Each legal product state is a distinct type
interface GR { readonly kind: "GR" }
interface YR { readonly kind: "YR" }
interface RR { readonly kind: "RR" }
interface RG { readonly kind: "RG" }
interface RY { readonly kind: "RY" }
interface FF { readonly kind: "FF" }

type IntersectionState = GR | YR | RR | RG | RY | FF;

// Transitions — only legal ones exist
function grNext(_state: GR): YR { return { kind: "YR" }; }
function yrNext(_state: YR): RR { return { kind: "RR" }; }

function rrNorthSouthFirst(_state: RR): GR { return { kind: "GR" }; }
function rrEastWestFirst(_state: RR): RG { return { kind: "RG" }; }

function rgNext(_state: RG): RY { return { kind: "RY" }; }
function ryNext(_state: RY): RR { return { kind: "RR" }; }

function fault(_state: IntersectionState): FF { return { kind: "FF" }; }
function restore(_state: FF): RR { return { kind: "RR" }; }

// Controlled branching via a generic dispatch
type RRChoice<T> = {
  fromNorthSouth: (rr: RR) => T;
  fromEastWest: (rr: RR) => T;
};

function rrDispatch<T>(state: RR, choice: RRChoice<T>): T {
  // The choice parameter selects among legal branches
  // while the types still reject impossible ones
  return choice.fromNorthSouth(state); // or fromEastWest — caller decides
}

// Chained usage
function normalCycle(): RR {
  const start: RR = { kind: "RR" };
  const gr = rrNorthSouthFirst(start);
  const yr = grNext(gr);
  const rr1 = yrNext(yr);
  const rg = rrEastWestFirst(rr1);
  const ry = rgNext(rg);
  return ryNext(ry);
}
```

This pattern adds two useful ideas on top of ordinary state machines.

### Product-state encoding

The intersection type represents the combined state of both lights. But callers never construct arbitrary pairs. Instead, they work only with the finite set of legal concrete states: `GR`, `YR`, `RR`, `RG`, `RY`, and `FF`.

That is often the right pattern when:

- local state is constrained by a global invariant,
- two actors must transition in lockstep,
- or a coordinator must enforce safety across several subsystems.

### Controlled branching via type dispatch

Some states have more than one legal next state. In the traffic light example, `RR` may hand control to either direction. That is not ordinary nondeterminism; it is controlled branching.

There are two clean ways to express that:

- expose named transition functions such as `rrNorthSouthFirst()` and `rrEastWestFirst()`,
- add a typed dispatch mechanism (callback object or function parameter) so callers can choose among the legal branches while the compiler still rejects impossible ones.

### When this pattern is a good fit

- Use product-state encoding when invariants span more than one entity.
- Use explicit concrete state types when illegal combinations must be impossible to construct.
- Use controlled branching when some states have a small, closed set of legal successor states.

This pattern is usually best implemented with distinct state interfaces and explicit transition functions. It also fits LemmaScript well, because contracts can be attached to each legal transition locally.

## Capabilities as state machines

Capabilities can be modeled as a state machine too. This is a specialized form
of typestate. Instead of saying an object is in state `Draft` or `Paid`, we say
a value carries a capability such as `Authenticated`, `MfaVerified`, or
`AdminApproved`. Each transition grants, refines, or revokes what the caller is
allowed to do next.

TypeScript's branded types provide a lightweight way to express this style without a dedicated utility class. The payload is the real runtime value, and the brand is compile-time state. Because intersecting a brand with an existing type changes only the type, it works well for typestate and capability-oriented APIs.

Example:

```typescript
declare const __brand: unique symbol;
type Brand<T extends string> = { readonly [__brand]: T };

// Capability brands
type Anonymous = Brand<"Anonymous">;
type Authenticated = Brand<"Authenticated">;
type MfaVerified = Brand<"MfaVerified"> & Authenticated;  // MfaVerified implies Authenticated
type LoggedOut = Brand<"LoggedOut">;

// Session data
interface Session {
  readonly userId: string;
}

// Branded session
type BrandedSession<Cap extends Brand<string>> = Session & Cap;

// Transitions
function begin(userId: string): BrandedSession<Anonymous> {
  return { userId } as BrandedSession<Anonymous>;
}

function login(session: BrandedSession<Anonymous>, _password: string): BrandedSession<Authenticated> {
  return session as unknown as BrandedSession<Authenticated>;
}

function verifySecondFactor(
  session: BrandedSession<Authenticated>,
  _code: string
): BrandedSession<MfaVerified> {
  return session as unknown as BrandedSession<MfaVerified>;
}

function logout<T extends Authenticated>(session: BrandedSession<T>): BrandedSession<LoggedOut> {
  return session as unknown as BrandedSession<LoggedOut>;
}

// Capability-gated operations
function readProfile(session: BrandedSession<Authenticated>): string {
  return `profile for ${session.userId}`;
}

interface TransferRequest {
  readonly from: string;
  readonly to: string;
  readonly cents: number;
}

function transferMoney(session: BrandedSession<MfaVerified>, request: TransferRequest): void {
  if (request.cents <= 0) {
    throw new Error("cents must be positive");
  }
  // process transfer
}

// Usage
const session = begin("alice");
const authenticated = login(session, "correct horse battery staple");
const profile = readProfile(authenticated);
const elevated = verifySecondFactor(authenticated, "123456");
transferMoney(elevated, { from: "checking", to: "savings", cents: 5_000 });
const loggedOut = logout(elevated);

// Does not compile:
// transferMoney(authenticated, { from: "checking", to: "savings", cents: 5_000 });
```

This pattern is useful because the capability itself becomes the transition guard. The function signature says what proof of authority is required.

### Where branded capabilities fit well

Branded capability types are especially useful when:

- the runtime value is simple and should not be wrapped in a large domain hierarchy,
- the state matters mainly for compile-time protocol checking,
- and the transition API can be expressed as brand changes over the same payload.

This makes branded capabilities a good fit for:

- capability-gated service calls,
- request processing pipelines,
- authenticated session lifecycles,
- and lightweight typestate over values like `string`, `URL`, `Record<string, unknown>`, or interfaces.

### Trust and witnesses

Plain branding via type assertions is enough when the goal is compile-time
discipline inside a trusted module. If the capability must also be protected
against forgery across trust boundaries (e.g., a library exporting branded
tokens), you can pair the brand with a runtime witness — a private `WeakSet` or
`Symbol` that proves the capability originated from approved code.

```typescript
const TRUSTED = new WeakSet<object>();

function mintAuthenticated(session: BrandedSession<Anonymous>): BrandedSession<Authenticated> {
  const result = session as unknown as BrandedSession<Authenticated>;
  TRUSTED.add(result);
  return result;
}

function requireTrusted(session: BrandedSession<Authenticated>): void {
  if (!TRUSTED.has(session)) {
    throw new Error("Untrusted session — capability was forged");
  }
}
```

That leads to a useful rule of thumb:

- use brands alone for lightweight internal typestate,
- use brands plus runtime witnesses for trusted capability minting across trust boundaries,
- and use dedicated state classes when behavior differs substantially by state.

## Performance Considerations

State-machine performance in JavaScript/TypeScript depends on the runtime shape of the implementation and V8's optimization pipeline.

### V8 optimization model

V8 (the engine behind Node.js, Deno, and Chrome) optimizes based on object shapes (hidden classes / maps), inline caches, and speculative JIT compilation. Key points for state machines:

- **Monomorphic call sites** are fastest. If a function always receives objects with the same hidden class, V8's inline cache hits consistently.
- **Polymorphic call sites** (2-4 hidden classes) are slower but manageable. V8 builds a polymorphic inline cache.
- **Megamorphic call sites** (5+ hidden classes) fall back to dictionary lookups, which are substantially slower.
- **Object shape stability** matters more than object count. Creating many objects with the same property layout in the same order is cheap; creating objects with varying shapes is expensive.
- **SMI (Small Integer)** values (31-bit signed integers on 64-bit systems) are stored unboxed. Arithmetic on SMIs avoids heap allocation entirely.
- **Escape analysis** in TurboFan can eliminate allocations for objects that do not escape the current function, but this is fragile and cannot be relied upon for correctness.

### Why branded typestate is often a strong performance choice

Branded typestate is a particularly attractive low-overhead option in TypeScript because the brand exists only in the type system.

- Type brands are erased at compile time. `Order & Brand<"Draft">` and `Order & Brand<"Paid">` are the same runtime object shape.
- That means the compiler-checked state marker itself is literally free at runtime — it does not exist in the emitted JavaScript.
- The remaining cost comes from the payload objects you choose to create, not from the brand.
- In practice, branded typestate that reuses the same object (via `as unknown as`) across transitions allocates nothing at all for the transition itself.

This is why branded types work well as a typestate mechanism: the tag is compile-time only, and the runtime cost is zero.

### Common performance pitfalls

- **Avoid assuming immutable designs are automatically fast.** A functional API that returns a new object literal on every transition (`{ ...order, state: "paid" }`) allocates on every call. When this matters, mutate in place and change only the brand at the type level.
- **Avoid shape pollution.** If different state types carry different properties (e.g., `PaidOrder` has `paidAt` but `DraftOrder` does not), V8 tracks these as different hidden classes. Mixing them through the same variable or collection makes call sites polymorphic. If performance matters, keep all states with the same runtime shape (use `undefined` for absent optional fields).
- **Avoid `delete` on objects.** Deleting a property changes an object's hidden class and de-optimizes downstream code.
- **Discriminated unions allocate per transition** unless you mutate the discriminant in place. `{ ...order, kind: "paid" }` creates a new object; `order.kind = "paid"` does not (but requires `kind` to be mutable).
- **Class-based state objects** are generally fast in V8 because each class produces a stable hidden class. However, creating a new class instance per transition is still an allocation.

### Practical guidance for low-overhead implementations

- Use **discriminated unions with mutation** when raw simplicity and minimal allocation matter more than compile-time transition safety. Mutating a `kind` field in place is a single property write — no allocation, no shape change.
- Use **branded typestate with in-place rebranding** when you want compiler-checked transitions with zero runtime overhead. The transition is just a type assertion; no code is emitted.
- Use **distinct state types (classes or interfaces)** when clarity and per-state behavior matter more than minimizing allocation.
- Use **packed numeric state** for true hot-loop scenarios (protocol parsers, binary stream processors, tight schedulers). Keep values as SMIs (under 2^30) to stay on V8's fast integer path.
- Use **singleton typestate** for the same hot-path scenarios when you still want typed transitions. The singleton instances are allocated once; transitions are just returning the existing singleton.

### Packed numerics in JavaScript

JavaScript's number type is IEEE 754 double-precision float, but V8 internally tracks integer values as SMIs when they fit in 31 bits (signed). Bitwise operators (`|`, `&`, `^`, `<<`, `>>>`) coerce to 32-bit integers.

- The 32-bit limit means packed state in a single `number` is limited to 32 bits of information.
- For wider packed state, `BigInt` is available but substantially slower (heap-allocated, no SMI optimization).
- Typed arrays (`Int32Array`, `Uint32Array`) provide fixed-layout packed storage without per-element object overhead, useful for arrays of packed state machines.
- In benchmark terms, packed-numeric state machines in a tight loop with SMI values will be the fastest possible implementation in JavaScript, often matching C-like throughput for simple transitions.

### Singleton typestate

Singleton typestate in JavaScript/TypeScript performs well because:

- Singleton instances are allocated once at module load time.
- Transitions return existing references, not new objects.
- When paired with a mutable data carrier, the per-transition allocation is zero.
- V8 can inline singleton method calls effectively because the receiver shape is always monomorphic.

Choose singleton typestate when:

- the machine runs on a hot path,
- illegal transitions should still fail at compile time,
- the code can tolerate a mutable carrier,
- and throughput matters more than maximizing readability.

### Rule of thumb

If you want the best balance of correctness and performance in ordinary TypeScript application code, branded typestate is often the sweet spot:

- stronger guarantees than discriminated unions,
- literally zero runtime cost for the brand itself,
- and a much lower conceptual overhead than many developers expect.

For performance-critical systems, a practical ladder is:

- packed numerics (SMI-range) for absolute speed,
- singleton typestate for near-zero-allocation code with compiler-checked transitions,
- branded typestate for the best everyday balance of safety and simplicity,
- distinct state types for the clearest domain model.
