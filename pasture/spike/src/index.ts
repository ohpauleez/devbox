#!/usr/bin/env node
import { Command } from "commander";
import { addCommand } from "./cli/commands/add.js";
import { connectCommand } from "./cli/commands/connect.js";
import { cpCommand } from "./cli/commands/cp.js";
import { downCommand } from "./cli/commands/down.js";
import { initCommand } from "./cli/commands/init.js";
import { listCommand } from "./cli/commands/list.js";
import { rmCommand } from "./cli/commands/rm.js";
import { switchCommand } from "./cli/commands/switch.js";
import { upCommand } from "./cli/commands/up.js";
import { EXIT_CODES, normalizeError, printError } from "./domain/errors.js";

const program = new Command();

program
  .name("devbox")
  .description("Create and manage AWS EC2 development machines")
  .action(async () => {
    await listCommand();
  });

program
  .command("list")
  .description("List tracked devboxes")
  .action(async () => {
    await listCommand();
  });

program
  .command("init")
  .argument("<alias>")
  .argument("<template-file>")
  .description("Launch an EC2 instance from JSON template")
  .action(async (alias: string, templateFile: string) => {
    await initCommand(alias, templateFile);
  });

program
  .command("add")
  .argument("<instance-id>")
  .argument("<alias>")
  .description("Track an existing EC2 instance")
  .action(async (instanceId: string, alias: string) => {
    await addCommand(instanceId, alias);
  });

program
  .command("rm")
  .argument("<alias>")
  .option("--terminate", "Terminate instance before removing alias", false)
  .description("Remove tracked alias")
  .action(async (alias: string, opts: { terminate: boolean }) => {
    await rmCommand(alias, opts.terminate);
  });

program
  .command("switch")
  .argument("<alias>")
  .description("Set current alias")
  .action(async (alias: string) => {
    await switchCommand(alias);
  });

program
  .command("up")
  .description("Start current instance or wait until running")
  .action(async () => {
    await upCommand();
  });

program
  .command("down")
  .description("Stop current instance or wait until stopped")
  .action(async () => {
    await downCommand();
  });

program
  .command("connect")
  .description("Connect to current instance over SSM+SSH")
  .action(async () => {
    await connectCommand();
  });

program
  .command("cp")
  .argument("<local>")
  .argument("<remote>")
  .description("Copy local file to current instance")
  .action(async (local: string, remote: string) => {
    await cpCommand(local, remote);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const normalized = normalizeError(err);
    printError(normalized);
    process.exitCode = EXIT_CODES[normalized.code] ?? 1;
  }
}

void main();
