import { randomUUID } from "node:crypto";

export interface Runtime {
  nowMs(): number;
  nowIso(): string;
  sleep(ms: number): Promise<void>;
  nextId(): string;
}

export const realRuntime: Runtime = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  nextId: () => randomUUID(),
};
