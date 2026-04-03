import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/client.js";
import type { AuthGuard } from "../auth-service.js";
import {
  createLobby,
  endMatch,
  disbandLobby,
  getCurrentLobbyForUser,
  getLobbyByCode,
  joinLobby,
  leaveLobby,
  setLobbyCharacter,
  setLobbyMap,
  setReadyState,
  startMatch,
} from "../lobby-service.js";
import type { RealtimeHub } from "../realtime-hub.js";
import { parseOrThrow } from "../validation.js";

const createLobbySchema = z.object({
  maxPlayers: z.literal(2),
  selectedCharacterId: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i),
  selectedMapId: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i),
});

const joinLobbySchema = z.object({
  code: z.string().trim().min(1).max(16),
  selectedCharacterId: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i),
});

const readySchema = z.object({
  ready: z.boolean(),
});

const selectedCharacterSchema = z.object({
  selectedCharacterId: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i),
});

const selectedMapSchema = z.object({
  selectedMapId: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i),
});

const codeParamsSchema = z.object({
  code: z.string().trim().min(1).max(16),
});

type LobbyRoutesOptions = {
  db: AppDatabase;
  config: AppConfig;
  authGuard: AuthGuard;
  realtimeHub: RealtimeHub;
};

export function registerLobbyRoutes(app: FastifyInstance, options: LobbyRoutesOptions) {
  const { db, config, authGuard, realtimeHub } = options;

  app.get("/lobbies/current", { preHandler: authGuard }, async (request) => ({
    lobby: getCurrentLobbyForUser(db, config, request.auth.id),
  }));

  app.post("/lobbies", { preHandler: authGuard }, async (request) => {
    const body = parseOrThrow(createLobbySchema, request.body);
    const lobby = createLobby(
      db,
      config,
      request.auth.id,
      body.maxPlayers,
      body.selectedCharacterId,
      body.selectedMapId,
    );
    if (lobby) {
      realtimeHub.broadcastLobbyState(lobby.code, lobby);
    }
    return lobby;
  });

  app.post("/lobbies/join", { preHandler: authGuard }, async (request) => {
    const body = parseOrThrow(joinLobbySchema, request.body);
    const lobby = joinLobby(db, config, request.auth.id, body.code, body.selectedCharacterId);
    if (lobby) {
      realtimeHub.broadcastLobbyState(lobby.code, lobby);
    }
    return lobby;
  });

  app.get("/lobbies/:code", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    return getLobbyByCode(db, config, params.code);
  });

  app.post("/lobbies/:code/ready", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    const body = parseOrThrow(readySchema, request.body);
    const lobby = setReadyState(db, config, request.auth.id, params.code, body.ready);
    if (lobby) {
      realtimeHub.broadcastLobbyState(lobby.code, lobby);
    }
    return lobby;
  });

  app.post("/lobbies/:code/character", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    const body = parseOrThrow(selectedCharacterSchema, request.body);
    const lobby = setLobbyCharacter(
      db,
      config,
      request.auth.id,
      params.code,
      body.selectedCharacterId,
    );
    if (lobby) {
      realtimeHub.broadcastLobbyState(lobby.code, lobby);
    }
    return lobby;
  });

  app.post("/lobbies/:code/map", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    const body = parseOrThrow(selectedMapSchema, request.body);
    const lobby = setLobbyMap(
      db,
      config,
      request.auth.id,
      params.code,
      body.selectedMapId,
    );
    if (lobby) {
      realtimeHub.broadcastLobbyState(lobby.code, lobby);
    }
    return lobby;
  });

  app.post("/lobbies/:code/start", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    const lobby = startMatch(
      db,
      config,
      request.auth.id,
      params.code,
      (memberUserId, code) => realtimeHub.isUserConnectedToLobby(memberUserId, code),
    );
    if (!lobby?.activeMatch) {
      throw new Error("Match did not start correctly.");
    }
    const matchState = realtimeHub.initializeMatchRuntime(lobby.code, lobby);
    realtimeHub.broadcastMatchStarted(lobby.code, lobby.activeMatch);
    realtimeHub.broadcastMatchState(lobby.code, matchState);
    realtimeHub.broadcastLobbyState(lobby.code, lobby);
    return { ok: true };
  });

  app.post("/lobbies/:code/end-match", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    const result = endMatch(db, config, request.auth.id, params.code);
    if (result.matchEndedReason) {
      realtimeHub.broadcastMatchEnded(result.code, result.matchEndedReason);
    }
    realtimeHub.broadcastLobbyState(result.code, result.lobby);
    return { ok: true };
  });

  app.post("/lobbies/:code/leave", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    const result = leaveLobby(db, config, request.auth.id, params.code);
    if (result.matchEndedReason) {
      realtimeHub.broadcastMatchEnded(result.code, result.matchEndedReason);
    }
    realtimeHub.broadcastLobbyState(result.code, result.lobby);
    return { ok: true };
  });

  app.delete("/lobbies/:code", { preHandler: authGuard }, async (request) => {
    const params = parseOrThrow(codeParamsSchema, request.params);
    const result = disbandLobby(db, config, request.auth.id, params.code);
    if (result.matchEndedReason) {
      realtimeHub.broadcastMatchEnded(result.code, result.matchEndedReason);
    }
    realtimeHub.broadcastLobbyState(result.code, result.lobby);
    return { ok: true };
  });
}
