import { describe, expect, it } from "vitest";
import {
  validateRequiredTags,
  mergeRequiredTags,
  BUILTIN_REQUIRED_TAG_DEFAULTS,
} from "../../src/domain/tags.js";
import { mapInitTemplateToRunInstances } from "../../src/domain/init-mapper.js";
import type { DefaultsConfig } from "../../src/domain/types.js";
import { traceSpec } from "../support/spec-trace.js";

const validTags = {
  env: "dev",
  service: "devbox",
  version: "0000000",
  "customer-data": "false",
  team: "devbox",
};

describe("validateRequiredTags", () => {
  it("accepts valid defaults", () => {
    const result = validateRequiredTags(validTags);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid env", () => {
    traceSpec("BOX-DOMAIN-TAGS-VALUES", "BOX-TAGS-VALUE-FAIL");

    const result = validateRequiredTags({ ...validTags, env: "production" });
    expect(result.ok).toBe(false);
  });

  it("rejects bad version length (too short)", () => {
    traceSpec("BOX-DOMAIN-TAGS-VALUES", "BOX-TAGS-VALUE-FAIL");

    const result = validateRequiredTags({ ...validTags, version: "abc" });
    expect(result.ok).toBe(false);
  });

  it("rejects bad version length (too long)", () => {
    traceSpec("BOX-DOMAIN-TAGS-VALUES", "BOX-TAGS-VALUE-FAIL");

    const result = validateRequiredTags({ ...validTags, version: "a".repeat(41) });
    expect(result.ok).toBe(false);
  });

  it("rejects bad customer-data", () => {
    traceSpec("BOX-DOMAIN-TAGS-VALUES", "BOX-TAGS-VALUE-FAIL");

    const result = validateRequiredTags({ ...validTags, "customer-data": "yes" });
    expect(result.ok).toBe(false);
  });
});

describe("mergeRequiredTags", () => {
  it("user tags override builtin defaults", () => {
    const userTags = { ...validTags, team: "myteam" };
    const merged = mergeRequiredTags(userTags);
    expect(merged.team).toBe("myteam");
  });

  it("preserves builtin defaults for unspecified fields", () => {
    const merged = mergeRequiredTags(validTags);
    expect(merged).toEqual({ ...BUILTIN_REQUIRED_TAG_DEFAULTS, ...validTags });
  });
});

describe("Name tag forced to alias", () => {
  const defaults: DefaultsConfig = {
    tags: validTags,
    ImageId: "ami-default",
    IamInstanceProfile: { Arn: "arn:aws:iam::123:instance-profile/default" },
  };

  it("Name tag is always forced to alias value regardless of template tags", () => {
    traceSpec("BOX-DOMAIN-TAGS-MERGE", "BOX-TAGS-NAME-OVERRIDE");

    const template = {
      ImageId: "ami-template",
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [{ Key: "Name", Value: "should-be-overridden" }],
        },
      ],
    };

    const result = mapInitTemplateToRunInstances("myalias", template, defaults);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tagSpecs = result.value.payload.TagSpecifications as Array<{
      ResourceType: string;
      Tags: Array<{ Key: string; Value: string }>;
    }>;
    const instanceSpec = tagSpecs.find((s) => s.ResourceType === "instance");
    const nameTag = instanceSpec?.Tags.find((t) => t.Key === "Name");
    expect(nameTag?.Value).toBe("myalias");
  });
});
