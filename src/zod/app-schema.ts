import z from "zod";
import { normalizeVolumes, normalizeNotificationConfig } from "@explita/protocol";

export const notifySchema = z.preprocess((val) => {
  if (val === null) return null;
  return normalizeNotificationConfig(val);
}, z.object({
  discord: z.string().optional(),
  slack: z.string().optional(),
  telegram: z.union([
    z.string(),
    z.object({
      chatId: z.string(),
      token: z.string().optional(),
    }),
  ]).optional(),
  events: z.array(z.string()).optional(),
}).nullable().optional());

const volumesSchema = z.preprocess((val) => {
  return normalizeVolumes(val);
}, z.record(z.string(), z.string()).nullable().optional());

const preDeploySchema = z.preprocess((val) => {
  if (val === undefined) return undefined;
  if (!val) return [];
  if (Array.isArray(val))
    return val.map((s) => String(s).trim()).filter(Boolean);
  if (typeof val === "string") {
    const t = val.trim();
    if (!t) return [];
    if (t.startsWith("[") && t.endsWith("]")) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) {
          return parsed.map((s) => String(s).trim()).filter(Boolean);
        }
      } catch {}
    }
    return [t];
  }
  return [];
}, z.array(z.string()).optional());

const healthCheckSchema = z.preprocess((val) => {
  if (val === undefined) return undefined;
  if (val === null || val === false || val === "") return null;
  if (val === true) return "/";
  if (typeof val === "string") {
    const t = val.trim();
    if (!t) return null;
    return t.startsWith("/") ? t : `/${t}`;
  }
  if (typeof val === "object" && val && "path" in val) {
    const p = String((val as any).path).trim();
    return p ? (p.startsWith("/") ? p : `/${p}`) : "/";
  }
  return null;
}, z.string().nullable().optional());

export const cronJobSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  schedule: z.string().min(1),
  command: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  paused: z.boolean().optional(),
});

export const createAppSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .transform((s) => s.trim()),
  port: z.number().int().positive().optional(),
  domains: z.array(z.string()).default([]),
  tunnel: z.boolean().optional(),
  tunnelEnabled: z.boolean().optional(),
  preDeploy: preDeploySchema.default([]),
  healthCheck: healthCheckSchema.default("/"),
  crons: z.array(cronJobSchema).optional().default([]),
  volumes: volumesSchema,
  notify: notifySchema,
});

export type CreateAppInput = z.infer<typeof createAppSchema>;

export const updateAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  port: z.number().int().positive().optional(),
  tunnel: z.boolean().optional(),
  tunnelEnabled: z.boolean().optional(),
  memory: z.string().nullable().optional(),
  cpus: z.union([z.string(), z.number()]).nullable().optional(),
  preDeploy: preDeploySchema,
  healthCheck: healthCheckSchema,
  crons: z.array(cronJobSchema).optional(),
  volumes: volumesSchema,
  notify: notifySchema,
});
