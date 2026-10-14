import z from "zod";

export const setBackupS3Schema = z.object({
  bucket: z.string().min(1, "Bucket name is required"),
  accessKeyId: z.string().min(1, "Access Key ID is required"),
  secretAccessKey: z.string().min(1, "Secret Access Key is required"),
  endpoint: z.string().optional(),
  region: z.string().optional().default("auto"),
  prefix: z.string().optional().default("backups"),
  forcePathStyle: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true),
});
