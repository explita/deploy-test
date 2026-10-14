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
