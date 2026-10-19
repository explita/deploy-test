import "@explita/env-loader/auto";
import { defineConfig } from "prisma/config";

import { appDbUrl } from "./src/lib/constants.ts";

export default defineConfig({
  schema: "src/prisma",
  migrations: {
    path: "src/prisma/migrations",
  },
  datasource: {
    url: appDbUrl,
  },
});
