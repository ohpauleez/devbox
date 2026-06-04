/**
 * @module process
 *
 * Subprocess execution adapter using argv-based invocation (no shell interpolation).
 *
 * This module wraps Node's `execFile` to provide a safe, Result-oriented interface
 * for spawning child processes. Arguments are passed directly to the kernel without
 * shell expansion, preventing injection attacks even with untrusted input.
 *
 * @remarks
 * All output is captured as UTF-8 strings with a 10 MiB buffer limit.
 * The module never spawns a shell — only direct executable invocation is supported.
 *
 * @example
 * ```ts
 * import { runProcess } from "./adapters/process.js";
 *
 * const result = await runProcess("git", ["status", "--porcelain"]);
 * if (result.ok) {
 *   console.log(result.value.stdout);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { makeError, type DevboxError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

const execFileAsync = promisify(execFile);

/**
 * Captured output streams from a successful subprocess execution.
 *
 * @remarks
 * Both fields are UTF-8 decoded strings. Either may be empty but never undefined.
 */
export interface ProcessSuccess {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Execute a local command using argv invocation without shell interpolation.
 *
 * @param file - Executable name or absolute path to invoke. Must be non-empty.
 * @param args - Argument vector passed directly to `execFile`. No shell expansion occurs;
 *   entries must not be null or undefined.
 * @returns On success (`ok`): captured stdout and stderr as UTF-8 strings.
 *   On error (`err`): a `DependencyError` when the executable is not found (ENOENT),
 *   or a `TransportError` when the command exits non-zero or is killed by a signal.
 *
 * @remarks
 * Precondition: `file` is a non-empty executable name; `args` contains no null/undefined entries.
 * Postcondition: on success, stdout/stderr are UTF-8 decoded strings from the child process.
 * Invariant: arguments are never shell-interpolated — `execFile` bypasses `/bin/sh`.
 * Bounds: output buffer is capped at 10 MiB; commands producing more output will fail.
 * Concurrency: safe to call concurrently; each invocation spawns an independent child process.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await runProcess("aws", ["ec2", "describe-instances", "--output", "json"]);
 * if (!result.ok) {
 *   // result.error.category is "DependencyError" | "TransportError"
 *   handleError(result.error);
 * }
 * ```
 */
export async function runProcess(
  file: string,
  args: readonly string[],
): Promise<Result<ProcessSuccess, DevboxError>> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args as string[], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return ok({ stdout, stderr });
  } catch (error: unknown) {
    // Node's execFile rejects with an Error that carries optional errno/stdout/stderr fields.
    // We narrow defensively: each property is checked for existence and type before use,
    // because the rejection value shape is not contractually guaranteed across Node versions.
    if (!(error instanceof Error)) {
      return err(makeError("TransportError", `command failed: ${file}`, [`${error}`]));
    }

    // ENOENT indicates the executable itself was not found on $PATH or at the given path.
    // This is semantically distinct from a command that ran but exited non-zero.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return err(makeError("DependencyError", `required executable not found: ${file}`));
    }

    // For non-zero exit or signal termination, extract any output the child produced.
    // stderr is preferred (conventional error stream) but stdout is included as fallback
    // because some tools emit diagnostics on stdout.
    const errorWithOutput = error as { readonly stdout?: unknown; readonly stderr?: unknown };
    const details: string[] = [];
    if (typeof errorWithOutput.stderr === "string" && errorWithOutput.stderr.trim().length > 0) {
      details.push(...errorWithOutput.stderr.trimEnd().split("\n"));
    }
    if (typeof errorWithOutput.stdout === "string" && errorWithOutput.stdout.trim().length > 0) {
      details.push(...errorWithOutput.stdout.trimEnd().split("\n"));
    }

    return err(makeError("TransportError", `command failed: ${file}`, details));
  }
}
