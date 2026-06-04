import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

describe("package metadata and build configuration", () => {
  let pkg: Record<string, unknown>;
  let tsconfig: Record<string, unknown>;

  beforeAll(async () => {
    const pkgRaw = await readFile(resolve(ROOT, "package.json"), "utf8");
    pkg = JSON.parse(pkgRaw) as Record<string, unknown>;

    const tsconfigRaw = await readFile(resolve(ROOT, "tsconfig.json"), "utf8");
    tsconfig = JSON.parse(tsconfigRaw) as Record<string, unknown>;
  });

  it("package.json has bin field pointing to dist/src/index.js", () => {
    const bin = pkg.bin as Record<string, string> | string;
    if (typeof bin === "string") {
      expect(bin).toContain("dist/src/index.js");
    } else {
      expect(Object.values(bin).some((v) => v.includes("dist/src/index.js"))).toBe(true);
    }
  });

  it('package.json has type: "module"', () => {
    expect(pkg.type).toBe("module");
  });

  it("package.json engines requires node >= 20", () => {
    const engines = pkg.engines as Record<string, string>;
    expect(engines).toBeDefined();
    expect(engines.node).toBeDefined();
    expect(engines.node).toMatch(/>=\s*20/);
  });

  it("tsconfig.json has strict: true", () => {
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions.strict).toBe(true);
  });

  it("tsconfig.json has noUncheckedIndexedAccess: true", () => {
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions.noUncheckedIndexedAccess).toBe(true);
  });
});
