import { FastifyInstance } from "fastify";
import { listVolumes } from "../services/volume/list.js";
import { inspectVolume } from "../services/volume/inspect.js";
import { deleteVolume } from "../services/volume/delete.js";

export function volumeRoutes(app: FastifyInstance) {
  app.get("/", listVolumes);
  app.get("/:name", inspectVolume);
  app.delete("/:name", deleteVolume);
}
