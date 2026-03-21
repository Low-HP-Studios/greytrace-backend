import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, {
  cors: {
    allowedOrigins: [
      process.env.BETTER_AUTH_URL,
      process.env.CORS_ORIGIN,
    ].filter((origin): origin is string => Boolean(origin)),
  },
});

export default http;
