import { spawn } from "node:child_process";
import { DevboxError } from "../domain/errors.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runProcess(
  command: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    stdin?: "inherit" | "ignore";
    stdout?: "pipe" | "inherit";
    stderr?: "pipe" | "inherit";
  },
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [options?.stdin ?? "ignore", options?.stdout ?? "pipe", options?.stderr ?? "pipe"],
      env: process.env,
    });

    let out = "";
    let err = "";
    let settled = false;

    const timeoutMs = options?.timeoutMs;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill("SIGTERM");
            reject(new DevboxError("TimeoutError", `Command timed out: ${command}`));
          }, timeoutMs)
        : undefined;

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (e.code === "ENOENT") {
        reject(new DevboxError("DependencyError", `Executable not found: ${command}`));
        return;
      }
      reject(new DevboxError("ValidationError", e.message));
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf8");
      });
    }

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        code: code ?? 1,
        stdout: out,
        stderr: err,
      });
    });
  });
}
