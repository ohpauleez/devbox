import { describe, expect, it, vi } from "vitest";
import { createInitCommand } from "../src/cli/commands/init.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";
import { DevboxError } from "../src/domain/errors.js";

describe("init command contracts", () => {
  it("launches one instance, updates config, sets current, prints instance id", async () => {
    const printed: string[] = [];
    const cfg = {
      ...synthesizeFirstRunConfig(),
      defaults: {
        ...synthesizeFirstRunConfig().defaults,
        ImageId: "ami-123",
        IamInstanceProfile: { Name: "Role" },
      },
    };

    const cmd = createInitCommand({
      validateAlias: vi.fn(),
      loadTemplateFile: vi.fn(async () => ({ InstanceType: "t3.small" })),
      readConfig: vi.fn(async () => cfg),
      mapPayload: vi.fn(() => ({ ImageId: "ami-123", IamInstanceProfile: { Name: "Role" }, MinCount: 1, MaxCount: 1 })),
      awsJson: vi.fn(async () => ({ Instances: [{ InstanceId: "i-123" }] })) as never,
      mutateConfig: vi.fn(async (mutator) => {
        const next = mutator(cfg);
        expect(next.boxes.work?.instanceId).toBe("i-123");
        expect(next.current).toBe("work");
        return next;
      }) as never,
      print: (s) => printed.push(s),
    });

    await cmd("work", "template.json");
    expect(printed).toEqual(["i-123"]);
  });

  it("validates alias before reading template", async () => {
    const order: string[] = [];
    const cmd = createInitCommand({
      validateAlias: vi.fn(() => {
        order.push("validate");
      }),
      loadTemplateFile: vi.fn(async () => {
        order.push("template");
        return {};
      }),
      readConfig: vi.fn(async () => {
        order.push("config");
        return synthesizeFirstRunConfig();
      }),
      mapPayload: vi.fn(() => ({})) as never,
      awsJson: vi.fn(async () => ({ Instances: [{ InstanceId: "i-1" }] })) as never,
      mutateConfig: vi.fn(async (m) => m(synthesizeFirstRunConfig())) as never,
      print: vi.fn(),
    });

    await cmd("work", "template.json");
    expect(order[0]).toBe("validate");
  });

  it("rejects alias duplicates before AWS launch", async () => {
    const cfg = synthesizeFirstRunConfig();
    cfg.boxes.work = { instanceId: "i-old" };
    const aws = vi.fn();
    const cmd = createInitCommand({
      validateAlias: vi.fn(),
      loadTemplateFile: vi.fn(async () => ({})),
      readConfig: vi.fn(async () => cfg),
      mapPayload: vi.fn(() => ({})) as never,
      awsJson: aws as never,
      mutateConfig: vi.fn() as never,
      print: vi.fn(),
    });

    await expect(cmd("work", "template.json")).rejects.toMatchObject({ code: "ValidationError" });
    expect(aws).not.toHaveBeenCalled();
  });

  it("maps config write failures to ConsistencyError after AWS success", async () => {
    const cfg = {
      ...synthesizeFirstRunConfig(),
      defaults: {
        ...synthesizeFirstRunConfig().defaults,
        ImageId: "ami-123",
        IamInstanceProfile: { Name: "Role" },
      },
    };

    const cmd = createInitCommand({
      validateAlias: vi.fn(),
      loadTemplateFile: vi.fn(async () => ({})),
      readConfig: vi.fn(async () => cfg),
      mapPayload: vi.fn(() => ({ ImageId: "ami-123", IamInstanceProfile: { Name: "Role" }, MinCount: 1, MaxCount: 1 })) as never,
      awsJson: vi.fn(async () => ({ Instances: [{ InstanceId: "i-123" }] })) as never,
      mutateConfig: vi.fn(async () => {
        throw new DevboxError("ConfigError", "disk full");
      }) as never,
      print: vi.fn(),
    });

    await expect(cmd("work", "template.json")).rejects.toMatchObject({ code: "ConsistencyError" });
  });

  it("fails when AWS does not return exactly one instance", async () => {
    const cfg = {
      ...synthesizeFirstRunConfig(),
      defaults: {
        ...synthesizeFirstRunConfig().defaults,
        ImageId: "ami-123",
        IamInstanceProfile: { Name: "Role" },
      },
    };
    const cmd = createInitCommand({
      validateAlias: vi.fn(),
      loadTemplateFile: vi.fn(async () => ({})),
      readConfig: vi.fn(async () => cfg),
      mapPayload: vi.fn(() => ({ ImageId: "ami-123", IamInstanceProfile: { Name: "Role" }, MinCount: 1, MaxCount: 1 })) as never,
      awsJson: vi.fn(async () => ({ Instances: [{ InstanceId: "i-1" }, { InstanceId: "i-2" }] })) as never,
      mutateConfig: vi.fn() as never,
      print: vi.fn(),
    });

    await expect(cmd("work", "template.json")).rejects.toMatchObject({ code: "AwsCliError" });
  });

  it("does not call mutateConfig when AWS launch fails", async () => {
    const mutate = vi.fn();
    const cfg = {
      ...synthesizeFirstRunConfig(),
      defaults: {
        ...synthesizeFirstRunConfig().defaults,
        ImageId: "ami-123",
        IamInstanceProfile: { Name: "Role" },
      },
    };

    const cmd = createInitCommand({
      validateAlias: vi.fn(),
      loadTemplateFile: vi.fn(async () => ({})),
      readConfig: vi.fn(async () => cfg),
      mapPayload: vi.fn(() => ({ ImageId: "ami-123", IamInstanceProfile: { Name: "Role" }, MinCount: 1, MaxCount: 1 })) as never,
      awsJson: vi.fn(async () => {
        throw new DevboxError("AwsCliError", "boom");
      }) as never,
      mutateConfig: mutate as never,
      print: vi.fn(),
    });

    await expect(cmd("work", "template.json")).rejects.toMatchObject({ code: "AwsCliError" });
    expect(mutate).not.toHaveBeenCalled();
  });
});
