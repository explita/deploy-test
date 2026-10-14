import z from "zod";

export const setEnvSchema = z.object({
  env: z.record(
    z.string().min(1),
    z.string(),
  ),
});

export const deleteEnvSchema = z.object({
  keys: z.array(z.string().min(1)).min(1),
});
