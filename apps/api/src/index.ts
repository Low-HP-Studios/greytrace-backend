import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { ConvexJwtVerifier } from "./auth";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { InMemoryRateLimiter } from "./rate-limit";
import { ConvexBackendService } from "./services/convex-backend";
import { registerSignalingRoute } from "./signaling";

const config = loadConfig();
const backend = new ConvexBackendService(config.CONVEX_URL);
const verifier = new ConvexJwtVerifier(config.CONVEX_SITE_URL);
const limiter = new InMemoryRateLimiter();

const app = createApp({
  config,
  backend,
  verifier,
  limiter,
});

const server = serve({
  fetch: app.fetch,
  port: config.PORT,
});

const websocket = createNodeWebSocket({ app });
registerSignalingRoute(app, {
  backend,
  verifier,
  upgradeWebSocket: websocket.upgradeWebSocket,
  limiter,
});
websocket.injectWebSocket(server);

console.log(`greytrace api listening on http://localhost:${config.PORT}`);
