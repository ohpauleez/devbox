#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertEqual(label, left, right) {
  if (left !== right) {
    throw new Error(`${label} mismatch\nleft: ${left}\nright: ${right}`);
  }
}

function main() {
  const srcHelp = run("node", ["dist/src/index.js", "--help"]);
  const bundleHelp = run("node", ["dist/devbox.js", "--help"]);
  assertEqual("help exit", String(srcHelp.code), String(bundleHelp.code));
  assertEqual("help stdout", srcHelp.stdout, bundleHelp.stdout);

  const srcVersion = run("node", ["dist/src/index.js", "--version"]);
  const bundleVersion = run("node", ["dist/devbox.js", "--version"]);
  assertEqual("version exit", String(srcVersion.code), String(bundleVersion.code));
  assertEqual("version stdout", srcVersion.stdout, bundleVersion.stdout);

  process.stdout.write("smoke parity checks passed\n");
}

main();
