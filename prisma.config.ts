import "@explita/env-loader/auto";
import { defineConfig } from "prisma/config";

const url =
  process.env.DATABASE_URL ||
  `postgresql://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/${encodeURIComponent(process.env.DB_NAME)}`;

export default defineConfig({
  schema: "src/prisma",
  migrations: {
    path: "src/prisma/migrations",
  },
  datasource: {
    url,
  },
});
