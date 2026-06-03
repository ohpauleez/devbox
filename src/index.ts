#!/usr/bin/env node

import { runAddCommand } from "./cli/commands/add.js";
import { runConnectCommand } from "./cli/commands/connect.js";
import { runCpCommand } from "./cli/commands/cp.js";
import { runDownCommand } from "./cli/commands/down.js";
import { runInitCommand } from "./cli/commands/init.js";
import { runListCommand } from "./cli/commands/list.js";
import { runLocalRemoveCommand, runTerminateRemoveCommand } from "./cli/commands/rm.js";
import { runSwitchCommand } from "./cli/commands/switch.js";
import { runUpCommand } from "./cli/commands/up.js";
import { exitCodeForError } from "./domain/errors.js";
import { renderHelp, renderVersion } from "./domain/output-contracts.js";
import { readPackageVersion } from "./domain/runtime.js";

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

function writeLines(lines: readonly string[], stream: NodeJS.WriteStream): void {
  if (lines.length === 0) {
    return;
  }
  stream.write(`${lines.join("\n")}\n`);
}

function parseInvocation(argv: readonly string[]): Invocation {
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

async function dispatch(invocation: Invocation, version: string): Promise<number> {
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

  if (invocation.kind === "invalid") {
    process.stderr.write(`[devbox] ValidationError: ${invocation.message}\n`);
    return 2;
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

  const code = exitCodeForError(commandResult.error);
  process.stderr.write(`[devbox] ${commandResult.error.category}: ${commandResult.error.message}\n`);
  if (commandResult.error.details) {
    for (const detail of commandResult.error.details) {
      process.stderr.write(`  ${detail}\n`);
    }
  }
  return code;
}

/**
 * CLI process entrypoint.
 *
 * @returns process exit code
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const versionResult = await readPackageVersion();
  if (!versionResult.ok) {
    process.stderr.write(`[devbox] ${versionResult.error.category}: ${versionResult.error.message}\n`);
    if (versionResult.error.details) {
      for (const detail of versionResult.error.details) {
        process.stderr.write(`  ${detail}\n`);
      }
    }
    return exitCodeForError(versionResult.error);
  }

  const invocation = parseInvocation(argv);
  return dispatch(invocation, versionResult.value);
}

void runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
