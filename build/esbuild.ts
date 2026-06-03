import { build } from "esbuild";

/**
 * Build single-file CLI bundle required by distribution tasks.
 */
async function runBuild(): Promise<void> {
  await build({
    entryPoints: ["src/index.ts"],
    outfile: "dist/devbox.js",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
  });
}

void runBuild();
