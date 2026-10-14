import { FastifyInstance } from "fastify";
import { pruneSystem } from "../services/system/prune.js";
import {
  getSystemStatsHttp,
  streamSystemStatsWs,
} from "../services/system/stats.js";
import { checkSystemDomain } from "../services/system/domain-check.js";
import { getSystemDoctor } from "../services/system/doctor.js";

export function systemRoutes(app: FastifyInstance) {
  app.get("/doctor", getSystemDoctor);
  app.post("/prune", pruneSystem);
  app.get("/domain-check", checkSystemDomain);

  app.route({
    method: "GET",
    url: "/stats",
    handler: getSystemStatsHttp,
    wsHandler: streamSystemStatsWs,
  });
}

