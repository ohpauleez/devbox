#!/usr/bin/env node

/**
 * @module index
 *
 * CLI entry point for the `devbox` tool.
 *
 * This module is the top-level orchestrator: it parses raw process arguments
 * into a typed {@link Invocation}, dispatches to the appropriate command
 * handler, and translates command results into process output and exit codes.
 *
 * @remarks
 * **Error-handling strategy:** All command errors are domain-typed
 * ({@link DevboxError}) and rendered via `renderErrorLines` rather than
 * thrown as exceptions. This ensures consistent, user-friendly stderr output
 * regardless of which subsystem fails. Exit codes are derived deterministically
 * from the error kind via `exitCodeForError`.
 *
 * **Exit code conventions:**
 * - `0` — success
 * - `1` — runtime/operational errors (network, AWS, SSH, filesystem)
 * - `2` — validation/usage errors (bad arguments, invalid invocation)
 *
 * The module uses eager imports for all command modules to favour explicit
 * dependency graphs and editor discoverability over cold-start latency.
 */

import { runAddCommand } from "./cli/commands/add.js";
import { runConnectCommand } from "./cli/commands/connect.js";
import { runCpCommand } from "./cli/commands/cp.js";
import { runDownCommand } from "./cli/commands/down.js";
import { runInitCommand } from "./cli/commands/init.js";
import { runListCommand } from "./cli/commands/list.js";
import { runLocalRemoveCommand, runTerminateRemoveCommand } from "./cli/commands/rm.js";
import { runSwitchCommand } from "./cli/commands/switch.js";
import { runUpCommand } from "./cli/commands/up.js";
import { exitCodeForError, renderErrorLines } from "./domain/errors.js";
import { renderHelp, renderVersion } from "./domain/output-contracts.js";
import { readPackageVersion } from "./domain/runtime.js";

/**
 * Command modules are imported at module scope for readability, consistency,
 * and stronger static discoverability in editor tooling.
 *
 * Lazy-loading each command during dispatch would reduce cold-start time for
 * simple invocations, but this entrypoint currently optimizes for explicit,
 * uniform import structure.
 */

type Invocation =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "list" }
  | { readonly kind: "switch"; readonly alias: string }
  | { readonly kind: "rm"; readonly alias: string; readonly terminate: boolean }
  | { readonly kind: "init"; readonly alias: string; readonly templateFile: string }
  | { readonly kind: "add"; readonly instanceId: string; readonly alias: string }
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  | { readonly kind: "connect"; readonly sshUserOverride?: string }
  | {
      readonly kind: "cp";
      readonly localPath: string;
      readonly remotePath: string;
      readonly sshUserOverride?: string;
    }
  | { readonly kind: "invalid"; readonly message: string };

type ExecutableInvocation = Exclude<Invocation, { readonly kind: "invalid" }>;

/**
 * Extracts an optional `--ssh-user <user>` flag from the head of an argument list.
 *
 * @param args - Remaining CLI arguments after the subcommand.
 * @returns An object containing the parsed SSH user (if present) and the
 *   unconsumed remainder of the argument list.
 *
 * @remarks
 * Precondition: `args` is the slice of argv following the subcommand token.
 * Postcondition: If `--ssh-user` is present with a following value, both are
 *   consumed from `rest`. Otherwise `rest === args` and `sshUserOverride` is
 *   undefined.
 * Invariant: Never mutates the input array.
 *
 * @throws Never throws.
 */
function parseOptionalSshUser(args: readonly string[]): { readonly sshUserOverride?: string; readonly rest: readonly string[] } {
  if (args.length >= 2 && args[0] === "--ssh-user" && args[1] !== undefined) {
    return {
      sshUserOverride: args[1],
      rest: args.slice(2),
    };
  }
  return {
    rest: args,
  };
}

/**
 * Writes an array of pre-formatted lines to a Node writable stream.
 *
 * @param lines - Lines to emit. An empty array results in no I/O.
 * @param stream - Target stream (typically `process.stdout` or `process.stderr`).
 *
 * @remarks
 * Postcondition: If `lines` is non-empty, exactly one `write` call is made
 *   with all lines joined by newline and a trailing newline appended.
 * Safety: Performs no encoding transformation; relies on Node's default UTF-8.
 *
 * @throws May throw if the underlying stream is destroyed or errored.
 */
function writeLines(lines: readonly string[], stream: NodeJS.WriteStream): void {
  if (lines.length === 0) {
    return;
  }
  stream.write(`${lines.join("\n")}\n`);
}

/**
 * Parses raw CLI argv tokens into a typed {@link Invocation} discriminated union.
 *
 * @param argv - Process arguments with the node/script prefix already stripped
 *   (i.e., `process.argv.slice(2)`).
 * @returns A fully-typed invocation. Invalid input yields `{ kind: "invalid" }`
 *   with a human-readable usage message rather than throwing.
 *
 * @remarks
 * Precondition: `argv` must not include the node binary or script path.
 * Postcondition: The returned invocation is exhaustively dispatchable; callers
 *   need only handle the `"invalid"` case separately before dispatching.
 * Invariant: Pure function — no side effects, no I/O.
 *
 * @throws Never throws.
 */
function parseInvocation(argv: readonly string[]): Invocation {
  // No arguments defaults to listing environments — the most common read operation.
  if (argv.length === 0) {
    return { kind: "list" };
  }

  const [command, ...rest] = argv;
  if (command === "-v" || command === "--version") {
    return { kind: "version" };
  }
  if (command === "-h" || command === "--help") {
    return { kind: "help" };
  }

  switch (command) {
    case "list":
      return rest.length === 0
        ? { kind: "list" }
        : { kind: "invalid", message: "list does not accept positional arguments" };
    case "switch":
      if (rest.length !== 1 || rest[0] === undefined) {
        return { kind: "invalid", message: "usage: devbox switch <alias>" };
      }
      return { kind: "switch", alias: rest[0] };
    case "rm": {
      const terminate = rest.includes("--terminate");
      const positional = rest.filter((arg) => arg !== "--terminate");
      if (positional.length !== 1 || positional[0] === undefined) {
        return { kind: "invalid", message: "usage: devbox rm <alias> [--terminate]" };
      }
      return { kind: "rm", alias: positional[0], terminate };
    }
    case "init":
      if (rest.length !== 2 || rest[0] === undefined || rest[1] === undefined) {
        return { kind: "invalid", message: "usage: devbox init <alias> <template-file>" };
      }
      return { kind: "init", alias: rest[0], templateFile: rest[1] };
    case "add":
      if (rest.length !== 2 || rest[0] === undefined || rest[1] === undefined) {
        return { kind: "invalid", message: "usage: devbox add <instance-id> <alias>" };
      }
      return { kind: "add", instanceId: rest[0], alias: rest[1] };
    case "up":
      return rest.length === 0
        ? { kind: "up" }
        : { kind: "invalid", message: "usage: devbox up" };
    case "down":
      return rest.length === 0
        ? { kind: "down" }
        : { kind: "invalid", message: "usage: devbox down" };
    case "connect":
      {
        const parsed = parseOptionalSshUser(rest);
        if (parsed.rest.length !== 0) {
          return { kind: "invalid", message: "usage: devbox connect [--ssh-user <user>]" };
        }
        return {
          kind: "connect",
          ...(parsed.sshUserOverride !== undefined ? { sshUserOverride: parsed.sshUserOverride } : {}),
        };
      }
    case "cp": {
      const parsed = parseOptionalSshUser(rest);
      if (parsed.rest.length !== 2 || parsed.rest[0] === undefined || parsed.rest[1] === undefined) {
        return { kind: "invalid", message: "usage: devbox cp <local> <remote>" };
      }
      return {
        kind: "cp",
        localPath: parsed.rest[0],
        remotePath: parsed.rest[1],
        ...(parsed.sshUserOverride !== undefined ? { sshUserOverride: parsed.sshUserOverride } : {}),
      };
    }
    default:
      return { kind: "invalid", message: `unknown command: ${command}` };
  }
}

/**
 * Executes a validated invocation by routing to the appropriate command handler
 * and translating results into output lines and an exit code.
 *
 * @param invocation - A valid (non-"invalid") parsed invocation.
 * @param version - The resolved package version string, used for `--version`
 *   and `--help` output.
 * @returns The numeric exit code: `0` on success, or a domain-appropriate code
 *   derived from the error kind on failure.
 *
 * @remarks
 * Precondition: `invocation.kind !== "invalid"` — callers must filter invalid
 *   invocations before calling dispatch.
 * Postcondition: All stdout/stderr output has been written before the returned
 *   promise resolves.
 * Invariant: Never throws — command failures are captured as `Result.err` and
 *   rendered to stderr via `renderErrorLines`.
 *
 * The error rendering strategy uses `renderErrorLines` (rather than raw
 * `Error.message`) because domain errors carry structured detail lines that
 * provide actionable context (e.g., which alias was not found, which AWS call
 * failed). `exitCodeForError` maps error kinds to conventional codes so that
 * shell scripts can branch on the exit status.
 *
 * @throws Never throws — all errors are surfaced as non-zero exit codes.
 */
async function dispatch(invocation: ExecutableInvocation, version: string): Promise<number> {
  // Version and help are handled first as pure-output fast paths that skip
  // any async infrastructure work.
  if (invocation.kind === "version") {
    const output = renderVersion(version);
    writeLines(output.stdoutLines, process.stdout);
    return 0;
  }

  if (invocation.kind === "help") {
    const output = renderHelp(version);
    writeLines(output.stdoutLines, process.stdout);
    return 0;
  }

  let commandResultPromise:
    | Promise<Awaited<ReturnType<typeof runListCommand>>>
    | Promise<Awaited<ReturnType<typeof runSwitchCommand>>>
    | Promise<Awaited<ReturnType<typeof runLocalRemoveCommand>>>
    | Promise<Awaited<ReturnType<typeof runInitCommand>>>
    | Promise<Awaited<ReturnType<typeof runAddCommand>>>
    | Promise<Awaited<ReturnType<typeof runUpCommand>>>
    | Promise<Awaited<ReturnType<typeof runDownCommand>>>
    | Promise<Awaited<ReturnType<typeof runConnectCommand>>>
    | Promise<Awaited<ReturnType<typeof runCpCommand>>>;

  switch (invocation.kind) {
    case "list":
      commandResultPromise = runListCommand();
      break;
    case "switch":
      commandResultPromise = runSwitchCommand(invocation.alias);
      break;
    case "rm":
      if (invocation.terminate) {
        commandResultPromise = runTerminateRemoveCommand(invocation.alias);
        break;
      }
      commandResultPromise = runLocalRemoveCommand(invocation.alias);
      break;
    case "init":
      commandResultPromise = runInitCommand(invocation.alias, invocation.templateFile);
      break;
    case "add":
      commandResultPromise = runAddCommand(invocation.instanceId, invocation.alias);
      break;
    case "up":
      commandResultPromise = runUpCommand();
      break;
    case "down":
      commandResultPromise = runDownCommand();
      break;
    case "connect":
      commandResultPromise = runConnectCommand(invocation.sshUserOverride);
      break;
    case "cp":
      commandResultPromise = runCpCommand(
        invocation.localPath,
        invocation.remotePath,
        invocation.sshUserOverride,
      );
      break;
  }

  const commandResult = await commandResultPromise;
  if (commandResult.ok) {
    writeLines(commandResult.value.stdoutLines, process.stdout);
    writeLines(commandResult.value.stderrLines, process.stderr);
    return commandResult.value.exitCode ?? 0;
  }

  // Render structured error lines to stderr rather than a raw message, because
  // domain errors include detail lines that give the user actionable context.
  const code = exitCodeForError(commandResult.error);
  writeLines(renderErrorLines(commandResult.error), process.stderr);
  return code;
}

/**
 * CLI process entry point. Orchestrates parsing, version resolution, and dispatch.
 *
 * @param argv - Process arguments with the node/script prefix stripped
 *   (typically `process.argv.slice(2)`).
 * @returns The process exit code to assign to `process.exitCode`.
 *
 * @remarks
 * Precondition: `argv` contains only the user-supplied tokens (no node path,
 *   no script path).
 * Postcondition: All output has been written to stdout/stderr; the returned
 *   number is safe to assign directly to `process.exitCode`.
 * Invariant: Never throws — validation failures return exit code `2`, runtime
 *   errors return codes derived from the error kind.
 *
 * **Flow:**
 * 1. Parse argv into a typed invocation (fail fast with code 2 on bad input).
 * 2. Resolve the package version (needed for `--version`/`--help` and future
 *    telemetry).
 * 3. Dispatch the validated invocation to the appropriate command handler.
 *
 * @throws Never throws — all failures are expressed as non-zero exit codes.
 *
 * @example
 * ```ts
 * const code = await runCli(["up"]);
 * process.exitCode = code;
 * ```
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const invocation = parseInvocation(argv);
  if (invocation.kind === "invalid") {
    // Exit code 2 signals a usage/validation error to shell callers.
    process.stderr.write(`[devbox] ValidationError: ${invocation.message}\n`);
    return 2;
  }

  const versionResult = await readPackageVersion();
  if (!versionResult.ok) {
    // Version resolution is required even for commands that don't display it,
    // because it validates that the package is installed correctly.
    writeLines(renderErrorLines(versionResult.error), process.stderr);
    return exitCodeForError(versionResult.error);
  }

  return dispatch(invocation, versionResult.value);
}

// Fire-and-forget the CLI, mapping the resolved exit code onto the process.
void runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
