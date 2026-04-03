import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import {
  type AuthGuard,
  createAuthGuard,
  getSessionUser,
  logoutSession,
  signIn,
  signUp,
} from "../auth-service.js";
import { leaveCurrentLobbyForUser } from "../lobby-service.js";
import type { RealtimeHub } from "../realtime-hub.js";
import { parseOrThrow } from "../validation.js";

const credentialsSchema = z.object({
  username: z.string(),
  password: z.string(),
});

type AuthRoutesOptions = {
  db: AppDatabase;
  config: AppConfig;
  authGuard: AuthGuard;
  realtimeHub: RealtimeHub;
};

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions) {
  const { db, config, authGuard, realtimeHub } = options;

  app.post("/auth/signup", async (request, reply) => {
    const body = parseOrThrow(credentialsSchema, request.body);
    const result = await signUp(db, config, body.username, body.password);
    reply.code(201).send(result);
  });

  app.post("/auth/login", async (request) => {
    const body = parseOrThrow(credentialsSchema, request.body);
    return signIn(db, config, body.username, body.password);
  });

  app.get("/auth/session", { preHandler: authGuard }, async (request) => ({
    user: getSessionUser(request.auth),
  }));

  app.post("/auth/logout", { preHandler: authGuard }, async (request) => {
    const leaveResult = leaveCurrentLobbyForUser(db, config, request.auth.id);
    logoutSession(db, request.auth);
    if (leaveResult?.matchEndedReason) {
      realtimeHub.broadcastMatchEnded(leaveResult.code, leaveResult.matchEndedReason);
    }
    if (leaveResult) {
      realtimeHub.broadcastLobbyState(leaveResult.code, leaveResult.lobby);
    }
    return { ok: true };
  });
}

export function buildAuthGuard(db: AppDatabase, config: AppConfig) {
  return createAuthGuard(db, config);
}
