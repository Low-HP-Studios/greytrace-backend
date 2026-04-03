import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { clearExpiredSessions } from "./auth-service.js";
import { resolveConfig, type AppConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { HttpError } from "./errors.js";
import { clearExpiredLobbies } from "./lobby-service.js";
import { createRealtimeHub } from "./realtime-hub.js";
import { buildAuthGuard, registerAuthRoutes } from "./routes/auth.js";
import { registerLobbyRoutes } from "./routes/lobbies.js";

export function buildApp(overrides: Partial<AppConfig> = {}): FastifyInstance {
  const config = resolveConfig(overrides);
  const { db, sqlite } = createDatabase(config.dbFilePath);

  clearExpiredSessions(db, config.now().toISOString());
  clearExpiredLobbies(db, config.now().toISOString());

  const app = Fastify({
    logger: false,
  });
  const realtimeHub = createRealtimeHub(db, config);

  app.register(cors, {
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Accept", "Authorization", "Content-Type"],
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
  });
  app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ message: error.message });
      return;
    }

    reply.code(500).send({ message: "Internal server error." });
  });

  app.get("/health", async () => ({ ok: true }));

  const authGuard = buildAuthGuard(db, config);
  app.after(() => {
    realtimeHub.registerRoutes(app);
  });
  registerAuthRoutes(app, { db, config, authGuard, realtimeHub });
  registerLobbyRoutes(app, { db, config, authGuard, realtimeHub });

  app.addHook("onClose", async () => {
    realtimeHub.close();
    sqlite.close();
  });

  return app;
}
