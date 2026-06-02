import { Runtime } from "../../src/domain/runtime.js";

export function createDeterministicRuntime(values?: {
  nowMs?: number[];
  nowIso?: string[];
  nextId?: string[];
}): Runtime {
  const nowMsValues = [...(values?.nowMs ?? [0])];
  const nowIsoValues = [...(values?.nowIso ?? ["2026-01-01T00:00:00.000Z"])];
  const nextIdValues = [...(values?.nextId ?? ["id-1"])];

  let nowMsIdx = 0;
  let nowIsoIdx = 0;
  let nextIdIdx = 0;

  return {
    nowMs: () => {
      const value = nowMsValues[Math.min(nowMsIdx, nowMsValues.length - 1)] ?? 0;
      nowMsIdx += 1;
      return value;
    },
    nowIso: () => {
      const value = nowIsoValues[Math.min(nowIsoIdx, nowIsoValues.length - 1)] ?? "2026-01-01T00:00:00.000Z";
      nowIsoIdx += 1;
      return value;
    },
    nextId: () => {
      const value = nextIdValues[Math.min(nextIdIdx, nextIdValues.length - 1)] ?? "id-1";
      nextIdIdx += 1;
      return value;
    },
    sleep: async () => {
      return;
    },
  };
}
