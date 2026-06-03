/**
 * Branded alias identifier.
 */
export type BoxAlias = string & { readonly __brand: "BoxAlias" };

/**
 * Branded EC2 instance identifier.
 */
export type InstanceId = string & { readonly __brand: "InstanceId" };

/**
 * Branded SSH user identifier.
 */
export type SshUser = string & { readonly __brand: "SshUser" };

/**
 * Immutable per-box config state.
 */
export interface BoxConfig {
  readonly instanceId: InstanceId;
  readonly lastConnectAt?: string;
  readonly sshUser?: SshUser;
}

/**
 * Required default tags for launched instances.
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
 */
export interface DefaultsConfig {
  readonly tags: RequiredTags;
  readonly ImageId?: string;
  readonly IamInstanceProfile?: {
    readonly Arn?: string;
    readonly Name?: string;
  };
  readonly sshUser?: SshUser;
}

/**
 * Full committed config shape.
 */
export interface DevboxConfig {
  readonly boxes: Readonly<Record<BoxAlias, BoxConfig>>;
  readonly current?: BoxAlias;
  readonly defaults: DefaultsConfig;
}
