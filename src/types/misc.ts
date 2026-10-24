export type RequestParams = {
  id?: string;
  appId?: string;
  deploymentId?: string;
  backupId?: string;
  [key: string]: string | undefined;
};

export type RequestQuery = {
  tunnel?: string;
  preview?: string;
  cloneDb?: string;
  key?: string;
  token?: string;
  [key: string]: any;
};

export interface ValidatedDbCloneParams {
  sourceDbName: string;
  ownerUser: string;
  cloneDbName: string;
  adminUser: string;
  safePort: number;
}

export interface AppEnvironmentOptions {
  /**
   * Optional database URL overrides. Used for previews or cloned database instances.
   * Can be a Map of database key to cloned connection URL, or a single string for default DB.
   */
  overrideDbUrls?: Map<string, string> | string;
  /**
   * Whether to reveal secrets in plaintext (default: true).
   * If false, secret values will be masked as "••••••••".
   */
  revealSecrets?: boolean;
}

export interface AppEnvironmentResult {
  /**
   * Key-value dictionary of all environment variables to be passed to the container.
   */
  env: Record<string, string>;
  /**
   * Docker command-line argument list (e.g. ["-e", "KEY=VALUE", ...])
   */
  dockerArgs: string[];
}
