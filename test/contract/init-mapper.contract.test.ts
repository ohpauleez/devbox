import { describe, expect, it } from "vitest";
import { mapInitTemplateToRunInstances } from "../../src/domain/init-mapper.js";
import type { DefaultsConfig } from "../../src/domain/types.js";

const defaults: DefaultsConfig = {
  tags: {
    env: "dev",
    service: "devbox",
    version: "0000000",
    "customer-data": "false",
    team: "devbox",
  },
  ImageId: "ami-default",
  IamInstanceProfile: { Arn: "arn:aws:iam::123:instance-profile/default" },
};

describe("mapInitTemplateToRunInstances", () => {
  it("rejects non-object template", () => {
    const result = mapInitTemplateToRunInstances("box", "string", defaults);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("JSON object");
  });

  it("rejects unknown template keys", () => {
    const result = mapInitTemplateToRunInstances("box", { FooBar: 1 }, defaults);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("unknown template");
  });

  it("rejects InstanceRequirements key", () => {
    const result = mapInitTemplateToRunInstances("box", { InstanceRequirements: {} }, defaults);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("InstanceRequirements");
  });

  it("rejects NetworkInterfaces + SecurityGroupIds conflict", () => {
    const result = mapInitTemplateToRunInstances(
      "box",
      { NetworkInterfaces: [], SecurityGroupIds: ["sg-1"] },
      defaults,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("NetworkInterfaces");
  });

  it("resolves ImageId from template over defaults", () => {
    const result = mapInitTemplateToRunInstances("box", { ImageId: "ami-template" }, defaults);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payload.ImageId).toBe("ami-template");
  });

  it("resolves ImageId from defaults when not in template", () => {
    const result = mapInitTemplateToRunInstances("box", {}, defaults);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payload.ImageId).toBe("ami-default");
  });

  it("requires ImageId from either source", () => {
    const noImage: DefaultsConfig = { tags: defaults.tags, IamInstanceProfile: defaults.IamInstanceProfile };
    const result = mapInitTemplateToRunInstances("box", {}, noImage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ImageId");
  });

  it("resolves IamInstanceProfile from template over defaults", () => {
    const template = { IamInstanceProfile: { Arn: "arn:template" } };
    const result = mapInitTemplateToRunInstances("box", template, defaults);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payload.IamInstanceProfile).toEqual({ Arn: "arn:template" });
  });

  it("requires IamInstanceProfile from either source", () => {
    const noProfile: DefaultsConfig = { tags: defaults.tags, ImageId: "ami-x" };
    const result = mapInitTemplateToRunInstances("box", {}, noProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("IamInstanceProfile");
  });

  it("UserData pass-through without transformation", () => {
    const result = mapInitTemplateToRunInstances("box", { UserData: "file:setup.sh" }, defaults);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.payload.UserData).toBe("file:setup.sh");
  });

  it("forced Name tag in output TagSpecifications", () => {
    const result = mapInitTemplateToRunInstances("mybox", {}, defaults);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tagSpecs = result.value.payload.TagSpecifications as Array<{
      ResourceType: string;
      Tags: Array<{ Key: string; Value: string }>;
    }>;
    const instanceSpec = tagSpecs.find((s) => s.ResourceType === "instance");
    const nameTag = instanceSpec?.Tags.find((t) => t.Key === "Name");
    expect(nameTag?.Value).toBe("mybox");
  });
});
