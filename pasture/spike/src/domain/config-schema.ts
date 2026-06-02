import { z } from "zod";
import { DevboxError } from "./errors.js";

const boxSchema = z.object({
  instanceId: z.string().min(1),
  lastConnectAt: z.string().datetime().optional(),
});

const tagsSchema = z
  .object({
    env: z.enum(["prod", "preprod", "staging", "dev"]),
    service: z.literal("devbox"),
    version: z
      .string()
      .min(7)
      .max(40),
    "customer-data": z.enum(["true", "false"]),
    team: z.string().min(1).max(64),
  })
  .catchall(z.string().min(1));

const defaultsSchema = z.object({
  ImageId: z.string().min(1).optional(),
  IamInstanceProfile: z
    .object({
      Name: z.string().min(1).optional(),
      Arn: z.string().min(1).optional(),
    })
    .optional(),
  tags: tagsSchema,
});

export const configSchema = z
  .object({
    current: z.string().optional(),
    boxes: z.record(boxSchema),
    defaults: defaultsSchema,
  })
  .superRefine((val, ctx) => {
    if (val.current && !val.boxes[val.current]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "current must reference an existing alias",
        path: ["current"],
      });
    }
  });

export type DevboxConfig = z.infer<typeof configSchema>;

export const BUILTIN_REQUIRED_TAG_DEFAULTS: DevboxConfig["defaults"]["tags"] = {
  env: "dev",
  service: "devbox",
  version: "0000000",
  "customer-data": "false",
  team: "engineering",
};

export function synthesizeFirstRunConfig(): DevboxConfig {
  return {
    boxes: {},
    defaults: {
      tags: BUILTIN_REQUIRED_TAG_DEFAULTS,
    },
  };
}

export function parseConfigOrThrow(payload: unknown): DevboxConfig {
  const parsed = configSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DevboxError(
      "ConfigError",
      "Invalid config schema",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
    );
  }
  return parsed.data;
}
