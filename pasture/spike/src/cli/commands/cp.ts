import fs from "node:fs/promises";
import path from "node:path";
import { readConfigForList, mutateConfig } from "../../adapters/config-store.js";
import { describeInstance } from "../../adapters/aws-cli.js";
import { scpViaSsm, sshMoveAndCleanup } from "../../adapters/ssh-cli.js";
import { requireCurrent } from "../../domain/context.js";
import { DevboxError } from "../../domain/errors.js";
import { printLine } from "../../domain/output-contracts.js";
import { validateRemotePath } from "../../domain/remote-path.js";
import { waitForSsmReadiness } from "../../domain/ssm-readiness.js";
import { Runtime, realRuntime } from "../../domain/runtime.js";

export interface CpDeps {
  stat: (p: string) => ReturnType<typeof fs.stat>;
  readConfig: typeof readConfigForList;
  mutateConfig: typeof mutateConfig;
  describe: typeof describeInstance;
  waitForSsm: typeof waitForSsmReadiness;
  scpUpload: typeof scpViaSsm;
  finalizeMove: typeof sshMoveAndCleanup;
  print: typeof printLine;
  validateRemotePath: typeof validateRemotePath;
  runtime: Runtime;
}

export function createCpCommand(deps?: Partial<CpDeps>): (local: string, remote: string) => Promise<void> {
  const d: CpDeps = {
    stat: deps?.stat ?? fs.stat,
    readConfig: deps?.readConfig ?? readConfigForList,
    mutateConfig: deps?.mutateConfig ?? mutateConfig,
    describe: deps?.describe ?? describeInstance,
    waitForSsm: deps?.waitForSsm ?? waitForSsmReadiness,
    scpUpload: deps?.scpUpload ?? scpViaSsm,
    finalizeMove: deps?.finalizeMove ?? sshMoveAndCleanup,
    print: deps?.print ?? printLine,
    validateRemotePath: deps?.validateRemotePath ?? validateRemotePath,
    runtime: deps?.runtime ?? realRuntime,
  };

  return async function cpCommandImpl(local: string, remote: string): Promise<void> {
    const stat = await d.stat(local).catch(() => {
      throw new DevboxError("ValidationError", `Local source does not exist: ${local}`);
    });
    if (!stat.isFile()) {
      throw new DevboxError("ValidationError", "Source must be a regular file");
    }
    if (stat.size > 1024 * 1024 * 1024) {
      throw new DevboxError("ValidationError", "Source file exceeds size limit");
    }
    d.validateRemotePath(remote);

    const cfg = await d.readConfig();
    const { alias, instanceId } = requireCurrent(cfg);
    const desc = await d.describe(instanceId);
    if (desc.state !== "running") {
      throw new DevboxError("InstanceStateError", `Instance is not running: ${instanceId}`);
    }
    await d.waitForSsm(instanceId);

    const dir = path.posix.dirname(remote);
    const base = path.posix.basename(remote);
    const temp = path.posix.join(dir, `.${base}.devbox-tmp-${d.runtime.nextId()}`);

    await d.scpUpload(instanceId, local, temp);
    await d.finalizeMove(instanceId, temp, remote);

    await d.mutateConfig((current) => {
      const box = current.boxes[alias];
      if (!box) {
        return current;
      }
      return {
        ...current,
        boxes: {
          ...current.boxes,
          [alias]: {
            ...box,
            lastConnectAt: d.runtime.nowIso(),
          },
        },
      };
    });

    d.print(`${alias} ${remote}`);
  };
}

export const cpCommand = createCpCommand();
