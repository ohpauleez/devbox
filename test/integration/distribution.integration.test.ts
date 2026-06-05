import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";

const ROOT = resolve(import.meta.dirname, "../..");
const DIST_BUNDLE_PATH = resolve(ROOT, "dist/devbox.js");
const DIST_SRC_ENTRY_PATH = resolve(ROOT, "dist/src/index.js");

function run(command: string, args: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("distribution integration", () => {
  beforeAll(() => {
    const build = run("npm", ["run", "build"]);
    expect(build.status).toBe(0);

    const bundle = run("npm", ["run", "bundle"]);
    expect(bundle.status).toBe(0);
  });

  it("bundle output exists at dist/devbox.js and begins with shebang", () => {
    traceSpec("DIST-CLI-BUNDLE", "DIST-BUNDLE-SHEBANG");

    expect(existsSync(DIST_BUNDLE_PATH)).toBe(true);

    const firstLine = readFileSync(DIST_BUNDLE_PATH, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("bundle and compiled entrypoint match for smoke parity commands", () => {
    traceSpec(
      "DIST-CLI-META",
      "DIST-VERSION-PARITY",
      "DIST-HELP-PARITY",
      "DIST-DOMAIN-PARITY",
      "DIST-PARITY-SMOKE",
    );

    expect(existsSync(DIST_SRC_ENTRY_PATH)).toBe(true);

    const srcHelp = run("node", [DIST_SRC_ENTRY_PATH, "--help"]);
    const bundleHelp = run("node", [DIST_BUNDLE_PATH, "--help"]);
    expect(srcHelp.status).toBe(bundleHelp.status);
    expect(srcHelp.stdout).toBe(bundleHelp.stdout);

    const srcVersion = run("node", [DIST_SRC_ENTRY_PATH, "--version"]);
    const bundleVersion = run("node", [DIST_BUNDLE_PATH, "--version"]);
    expect(srcVersion.status).toBe(bundleVersion.status);
    expect(srcVersion.stdout).toBe(bundleVersion.stdout);
  });

  it("npm package metadata supports standard CLI installation contract", async () => {
    traceSpec("DIST-CLI-NPM", "DIST-NPM-SUCCESS");

    const packageJsonText = await readFile(resolve(ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(packageJsonText) as {
      readonly bin?: string | Record<string, string>;
      readonly type?: string;
      readonly engines?: { readonly node?: string };
    };

    expect(pkg.type).toBe("module");
    expect(pkg.engines?.node).toMatch(/>=\s*20/);

    if (typeof pkg.bin === "string") {
      expect(pkg.bin).toContain("dist/src/index.js");
      return;
    }

    expect(pkg.bin).toBeDefined();
    expect(Object.values(pkg.bin ?? {}).some((binPath) => binPath.includes("dist/src/index.js"))).toBe(true);
  });

  it("distribution verification rejects broken npm metadata or output shape", async () => {
    traceSpec("DIST-NPM-FAIL");

    const packageJsonText = await readFile(resolve(ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(packageJsonText) as { readonly bin?: unknown };
    const hasSupportedBinShape =
      typeof pkg.bin === "string"
        ? pkg.bin.includes("dist/src/index.js")
        : typeof pkg.bin === "object" &&
          pkg.bin !== null &&
          Object.values(pkg.bin as Record<string, string>).some((binPath) => binPath.includes("dist/src/index.js"));

    expect(hasSupportedBinShape).toBe(true);
  });

  it("distribution verification rejects missing shebang runtime contract", () => {
    traceSpec("DIST-BUNDLE-FAIL");

    const bundleText = readFileSync(DIST_BUNDLE_PATH, "utf8");
    expect(bundleText.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("distribution parity verification rejects output or exit-code drift", () => {
    traceSpec("DIST-PARITY-FAIL");

    const srcVersion = run("node", [DIST_SRC_ENTRY_PATH, "--version"]);
    const bundleVersion = run("node", [DIST_BUNDLE_PATH, "--version"]);
    expect(srcVersion.status).toBe(bundleVersion.status);
    expect(srcVersion.stdout).toBe(bundleVersion.stdout);
    expect(srcVersion.stderr).toBe(bundleVersion.stderr);
  });

  it("no-arg invocation matches list behavior across distribution forms", async () => {
    traceSpec("BOX-CLI-TOPLEVEL", "BOX-NOARGS-LIST");

    const tempConfigDir = resolve(ROOT, ".tmp-trace-noargs");
    const { mkdir, rm } = await import("node:fs/promises");
    await rm(tempConfigDir, { recursive: true, force: true });
    await mkdir(tempConfigDir, { recursive: true });

    const env = { ...process.env, DEVBOX_CONFIG_DIR: tempConfigDir };
    const srcNoArgs = spawnSync("node", [DIST_SRC_ENTRY_PATH], { cwd: ROOT, encoding: "utf8", env });
    const bundleNoArgs = spawnSync("node", [DIST_BUNDLE_PATH], { cwd: ROOT, encoding: "utf8", env });

    expect(srcNoArgs.status).toBe(bundleNoArgs.status);
    expect(srcNoArgs.stdout).toBe(bundleNoArgs.stdout);
    expect(srcNoArgs.stderr).toBe(bundleNoArgs.stderr);
    expect(srcNoArgs.stdout).toContain("No boxes tracked");

    await rm(tempConfigDir, { recursive: true, force: true });
  });
});
