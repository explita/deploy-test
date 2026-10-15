import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { appRoutes, appRoutesWithId } from "./routes/app.js";
import { server } from "./lib/constants.js";
import { deploymentRoutes } from "./routes/deployment.js";
import { systemRoutes } from "./routes/system.js";
import { volumeRoutes } from "./routes/volume.js";
import { authHook } from "./hooks/auth.js";
import { normalizeIdPrefixesHook } from "./hooks/normalize-id-prefix.js";
import { errorHandler } from "./lib/error-handler.js";
import { init } from "./lib/init.js";

await init();

const app = Fastify({
  logger: process.env.NODE_ENV === "development",
  bodyLimit: server.maxRequestBodySize,
});

app.addContentTypeParser(
  ["application/gzip", "application/x-tar", "application/octet-stream"],
  { parseAs: "buffer" },
  (_req, body, done) => {
    done(null, body);
  },
);

// Stream parser for database restore payloads (passes raw stream directly without buffering in RAM)
app.addContentTypeParser(
  ["application/sql", "text/plain"],
  (_req, payload, done) => {
    done(null, payload);
  },
);

import { DEPLOY_VERSION } from "./version.js";

await app.register(cors);
await app.register(websocket);

app.addHook("onRequest", authHook);
app.addHook("onRequest", normalizeIdPrefixesHook);
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("x-explita-version", DEPLOY_VERSION);
  return payload;
});

app.get("/health", async () => ({
  ok: true,
  service: "explita-deploy",
  version: DEPLOY_VERSION,
}));

// register routes
app.register(appRoutes, { prefix: "/api/apps" });
app.register(appRoutesWithId, { prefix: "/api/apps" });
app.register(deploymentRoutes, { prefix: "/api/deployments" });
app.register(systemRoutes, { prefix: "/api/system" });
app.register(volumeRoutes, { prefix: "/api/volumes" });

app.setErrorHandler(errorHandler);

export { app };
