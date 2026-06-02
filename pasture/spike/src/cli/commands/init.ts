import { awsJson } from "../../adapters/aws-cli.js";
import { mutateConfig, readConfigForList } from "../../adapters/config-store.js";
import { validateAlias } from "../../domain/alias.js";
import { DevboxError } from "../../domain/errors.js";
import { loadTemplateFile, mapInitPayload } from "../../domain/init-mapper.js";
import { printLine } from "../../domain/output-contracts.js";

export interface InitDeps {
  validateAlias: typeof validateAlias;
  loadTemplateFile: typeof loadTemplateFile;
  readConfig: typeof readConfigForList;
  mapPayload: typeof mapInitPayload;
  awsJson: typeof awsJson;
  mutateConfig: typeof mutateConfig;
  print: typeof printLine;
}

export function createInitCommand(deps?: Partial<InitDeps>): (alias: string, templatePath: string) => Promise<void> {
  const d: InitDeps = {
    validateAlias: deps?.validateAlias ?? validateAlias,
    loadTemplateFile: deps?.loadTemplateFile ?? loadTemplateFile,
    readConfig: deps?.readConfig ?? readConfigForList,
    mapPayload: deps?.mapPayload ?? mapInitPayload,
    awsJson: deps?.awsJson ?? awsJson,
    mutateConfig: deps?.mutateConfig ?? mutateConfig,
    print: deps?.print ?? printLine,
  };

  return async function initCommandImpl(alias: string, templatePath: string): Promise<void> {
    d.validateAlias(alias);

    const template = await d.loadTemplateFile(templatePath);
    const cfg = await d.readConfig();
    if (cfg.boxes[alias]) {
      throw new DevboxError("ValidationError", `Alias already exists: ${alias}`);
    }
    const payload = d.mapPayload(alias, template, cfg);
    const args = ["ec2", "run-instances", "--output", "json", "--cli-input-json", JSON.stringify(payload)];
    const output = await d.awsJson<{
      Instances?: Array<{ InstanceId?: string }>;
    }>(args);
    const instanceId = output.Instances?.[0]?.InstanceId;
    if (!instanceId || output.Instances?.length !== 1) {
      throw new DevboxError("AwsCliError", "run-instances did not return exactly one instance ID");
    }

    try {
      await d.mutateConfig((current) => {
        if (current.boxes[alias]) {
          throw new DevboxError("ValidationError", `Alias already exists: ${alias}`);
        }
        return {
          ...current,
          boxes: {
            ...current.boxes,
            [alias]: {
              instanceId,
            },
          },
          current: alias,
        };
      });
    } catch (err) {
      const normalized = err instanceof DevboxError ? err : new DevboxError("ConfigError", "Config write failed");
      throw new DevboxError(
        "ConsistencyError",
        "Instance launched but local config update failed",
        `${normalized.code}: ${normalized.message}`,
      );
    }

    d.print(instanceId);
  };
}

export const initCommand = createInitCommand();
