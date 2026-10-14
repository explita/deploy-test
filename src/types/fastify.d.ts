import "fastify";
import type { FormattedApp } from "../lib/formatters/app.js";
import type { RequestParams, RequestQuery } from "./misc.js";

declare module "fastify" {
  interface FastifyRequest {
    ctx: {
      app: NonNullable<FormattedApp>;
      appId: string;
    };
  }

  interface RouteGenericInterface {
    Params?: RequestParams;
    Querystring?: RequestQuery;
  }
}
