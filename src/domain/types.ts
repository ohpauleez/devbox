/**
 * @module types
 *
 * Core domain types and interfaces for the devbox CLI configuration model.
 *
 * @remarks
 * All types in this module are immutable (readonly). Branded string types
 * (`BoxAlias`, `InstanceId`, `SshUser`) prevent accidental interchange of
 * raw strings where domain validation is required.
 */

/**
 * Branded alias identifier.
 *
 * @remarks
 * Invariant: values of this type satisfy `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
 * Construction: only via `parseAlias` which validates and brands the string.
 * Mutability: immutable (string primitive with phantom brand).
 */
export type BoxAlias = string & { readonly __brand: "BoxAlias" };

/**
 * Branded EC2 instance identifier.
 *
 * @remarks
 * Invariant: values are non-empty trimmed strings. Advisory pattern is
 * `i-` followed by 8 or 17 hex characters, but this is not enforced at
 * the type level to accommodate edge cases.
 * Construction: via `parseInstanceId` during config parsing.
 * Mutability: immutable (string primitive with phantom brand).
 */
export type InstanceId = string & { readonly __brand: "InstanceId" };

/**
 * Branded SSH user identifier.
 *
 * @remarks
 * Invariant: values are non-empty, contain no whitespace or ASCII control
 * characters (matches `^[^\s\x00-\x1f\x7f]+$`).
 * Construction: via config parsing or `resolveSshUser`.
 * Mutability: immutable (string primitive with phantom brand).
 */
export type SshUser = string & { readonly __brand: "SshUser" };

/**
 * Immutable per-box config state stored in the config file's `boxes` map.
 *
 * @remarks
 * Invariant: `instanceId` is always present and non-empty.
 * `lastConnectAt`, when present, is a valid ISO-8601 timestamp string.
 * `sshUser`, when present, satisfies the `SshUser` brand invariant.
 * Mutability: all fields are readonly; updates produce new objects.
 */
export interface BoxConfig {
  /** EC2 instance ID associated with this box. Always non-empty. */
  readonly instanceId: InstanceId;
  /** ISO-8601 timestamp of the last successful connection, if any. */
  readonly lastConnectAt?: string;
  /** Per-box SSH user override. Takes precedence over defaults.sshUser. */
  readonly sshUser?: SshUser;
}

/**
 * Required default tags for launched instances.
 *
 * @remarks
 * Invariant: all five keys are always present with non-empty string values.
 * `env` must be one of "prod", "preprod", "staging", "dev".
 * `service` must equal "devbox".
 * `version` length must be 7–40 characters.
 * `customer-data` must be "true" or "false".
 * `team` must be a non-empty identifier.
 * Mutability: all fields are readonly.
 */
export interface RequiredTags {
  readonly env: string;
  readonly service: string;
  readonly version: string;
  readonly "customer-data": string;
  readonly team: string;
}

/**
 * Default configuration values shared across commands.
 *
 * @remarks
 * Invariant: `tags` always satisfies `RequiredTags` constraints.
 * `ImageId`, when present, is a non-empty string.
 * `IamInstanceProfile`, when present, has at least one of `Arn` or `Name`.
 * Mutability: all fields are readonly; nested objects are also readonly.
 */
export interface DefaultsConfig {
  /** Required tags applied to all launched instances. */
  readonly tags: RequiredTags;
  /** Default AMI image ID. Overridable per-template. */
  readonly ImageId?: string;
  /** Default IAM instance profile. Must have at least Arn or Name. */
  readonly IamInstanceProfile?: {
    readonly Arn?: string;
    readonly Name?: string;
  };
  /** Default SSH user for remote-access commands. */
  readonly sshUser?: SshUser;
}

/**
 * Full committed config shape persisted to disk.
 *
 * @remarks
 * Invariant: all alias keys in `boxes` satisfy the `BoxAlias` pattern.
 * `current`, when present, must reference a key that exists in `boxes`.
 * Mutability: all fields are readonly; the `boxes` record is also readonly.
 */
export interface DevboxConfig {
  /** Map of tracked box aliases to their configurations. */
  readonly boxes: Readonly<Record<BoxAlias, BoxConfig>>;
  /** Currently selected box alias. Must be a key in `boxes` when present. */
  readonly current?: BoxAlias;
  /** Shared default configuration for all commands. */
  readonly defaults: DefaultsConfig;
}
