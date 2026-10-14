import "@explita/env-loader/auto";
import { app } from "./app.js";
import { server } from "./lib/constants.js";
import { logger } from "@explita/protocol";

app.listen({ port: server.port, host: server.host }, (err, address) => {
  if (err) {
    logger.error(`${err}`);
    process.exit(1);
  }

  logger.always(`Server running at ${address}`);
});
