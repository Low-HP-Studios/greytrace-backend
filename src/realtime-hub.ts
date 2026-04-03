import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { authenticateToken } from "./auth-service.js";
import type { AppConfig } from "./config.js";
import type {
  ActiveMatchPayload,
  AuthContext,
  LobbyPayload,
  MatchEndedReason,
  MatchPlayerRealtimeStatePayload,
  MatchStatePayload,
  ShotFiredPayload,
} from "./domain.js";
import type { AppDatabase } from "./db/client.js";
import { HttpError } from "./errors.js";
import {
  getCurrentLobbyForUser,
  getLobbyPayloadByCodeOrNull,
  handleRealtimeDisconnect,
} from "./lobby-service.js";
import {
  createMatchRuntimeManager,
  type IncomingPlayerState,
} from "./match-runtime.js";

type RealtimeClientMessage =
  | { type: "auth"; token: string }
  | { type: "subscribe_lobby"; code: string }
  | ({ type: "player_state" } & IncomingPlayerState)
  | { type: "fire"; shotId: string; weaponType: "rifle" }
  | { type: "reload"; requestId: string };

type RealtimeServerMessage =
  | { type: "auth_ok" }
  | { type: "lobby_state"; lobby: LobbyPayload | null }
  | { type: "match_started"; match: ActiveMatchPayload }
  | { type: "match_state"; state: MatchStatePayload }
  | { type: "player_state"; player: MatchPlayerRealtimeStatePayload }
  | { type: "shot_fired"; shot: ShotFiredPayload }
  | { type: "match_ended"; reason: MatchEndedReason }
  | { type: "error"; message: string };

type RealtimeClient = {
  socket: WebSocket;
  auth: AuthContext | null;
  subscribedLobbyCode: string | null;
};

export type RealtimeHub = {
  registerRoutes: (app: FastifyInstance) => void;
  close: () => void;
  isUserConnectedToLobby: (userId: string, code: string) => boolean;
  initializeMatchRuntime: (code: string, lobby: LobbyPayload) => MatchStatePayload;
  broadcastMatchState: (code: string, state?: MatchStatePayload | null) => void;
  broadcastLobbyState: (code: string, lobby?: LobbyPayload | null) => void;
  broadcastMatchStarted: (code: string, match: ActiveMatchPayload) => void;
  broadcastMatchEnded: (code: string, reason: MatchEndedReason) => void;
};

function normalizeLobbyCode(code: string) {
  return code.trim().toUpperCase();
}

function parseMessage(raw: RawData): RealtimeClientMessage {
  const text = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : raw instanceof Buffer
    ? raw.toString("utf8")
    : raw instanceof ArrayBuffer
    ? Buffer.from(raw).toString("utf8")
    : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid realtime message.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof parsed.type !== "string"
  ) {
    throw new HttpError(400, "Realtime message type is required.");
  }

  const parsedRecord = parsed as Record<string, unknown>;

  if (parsed.type === "auth") {
    if (typeof parsedRecord.token !== "string") {
      throw new HttpError(400, "Realtime auth token is required.");
    }
    return {
      type: "auth",
      token: parsedRecord.token,
    };
  }

  if (parsed.type === "subscribe_lobby") {
    if (typeof parsedRecord.code !== "string") {
      throw new HttpError(400, "Realtime lobby code is required.");
    }
    return {
      type: "subscribe_lobby",
      code: parsedRecord.code,
    };
  }

  if (parsed.type === "player_state") {
    const requiredNumberFields = ["seq", "x", "y", "z", "yaw", "pitch"] as const;
    for (const field of requiredNumberFields) {
      const value = parsedRecord[field];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new HttpError(400, `Realtime player state field "${field}" is required.`);
      }
    }

    const requiredBooleanFields = [
      "moving",
      "sprinting",
      "crouched",
      "grounded",
      "ads",
    ] as const;
    for (const field of requiredBooleanFields) {
      if (typeof parsedRecord[field] !== "boolean") {
        throw new HttpError(400, `Realtime player state field "${field}" is required.`);
      }
    }

    return {
      type: "player_state",
      seq: parsedRecord.seq as number,
      x: parsedRecord.x as number,
      y: parsedRecord.y as number,
      z: parsedRecord.z as number,
      yaw: parsedRecord.yaw as number,
      pitch: parsedRecord.pitch as number,
      moving: parsedRecord.moving as boolean,
      sprinting: parsedRecord.sprinting as boolean,
      crouched: parsedRecord.crouched as boolean,
      grounded: parsedRecord.grounded as boolean,
      ads: parsedRecord.ads as boolean,
    };
  }

  if (parsed.type === "fire") {
    if (typeof parsedRecord.shotId !== "string" || parsedRecord.shotId.trim().length === 0) {
      throw new HttpError(400, "Realtime fire shotId is required.");
    }
    if (parsedRecord.weaponType !== "rifle") {
      throw new HttpError(400, "Realtime fire weaponType must be rifle.");
    }
    return {
      type: "fire",
      shotId: parsedRecord.shotId,
      weaponType: "rifle",
    };
  }

  if (parsed.type === "reload") {
    if (typeof parsedRecord.requestId !== "string" || parsedRecord.requestId.trim().length === 0) {
      throw new HttpError(400, "Realtime reload requestId is required.");
    }
    return {
      type: "reload",
      requestId: parsedRecord.requestId,
    };
  }

  throw new HttpError(400, "Unknown realtime message.");
}

function socketReady(socket: WebSocket) {
  return socket.readyState === socket.OPEN;
}

function sendMessage(socket: WebSocket, message: RealtimeServerMessage) {
  if (!socketReady(socket)) {
    return;
  }

  socket.send(JSON.stringify(message));
}

export function createRealtimeHub(
  db: AppDatabase,
  config: AppConfig,
): RealtimeHub {
  const clients = new Set<RealtimeClient>();
  const subscriptionsByLobby = new Map<string, Set<RealtimeClient>>();
  const presenceByLobbyUser = new Map<string, number>();
  const matchRuntime = createMatchRuntimeManager();

  const makePresenceKey = (userId: string, code: string) =>
    `${normalizeLobbyCode(code)}:${userId}`;

  const clearSubscription = (client: RealtimeClient) => {
    if (!client.auth || !client.subscribedLobbyCode) {
      client.subscribedLobbyCode = null;
      return;
    }

    const code = client.subscribedLobbyCode;
    const subscribers = subscriptionsByLobby.get(code);
    if (subscribers) {
      subscribers.delete(client);
      if (subscribers.size === 0) {
        subscriptionsByLobby.delete(code);
      }
    }

    const presenceKey = makePresenceKey(client.auth.id, code);
    const nextCount = (presenceByLobbyUser.get(presenceKey) ?? 1) - 1;
    if (nextCount <= 0) {
      presenceByLobbyUser.delete(presenceKey);
    } else {
      presenceByLobbyUser.set(presenceKey, nextCount);
    }

    client.subscribedLobbyCode = null;
  };

  const attachSubscription = (client: RealtimeClient, code: string) => {
    const normalizedCode = normalizeLobbyCode(code);
    clearSubscription(client);

    if (!client.auth) {
      return;
    }

    const subscribers = subscriptionsByLobby.get(normalizedCode) ?? new Set<RealtimeClient>();
    subscribers.add(client);
    subscriptionsByLobby.set(normalizedCode, subscribers);

    const presenceKey = makePresenceKey(client.auth.id, normalizedCode);
    presenceByLobbyUser.set(presenceKey, (presenceByLobbyUser.get(presenceKey) ?? 0) + 1);
    client.subscribedLobbyCode = normalizedCode;
  };

  const broadcast = (code: string, message: RealtimeServerMessage, clearAfter = false) => {
    const normalizedCode = normalizeLobbyCode(code);
    const subscribers = subscriptionsByLobby.get(normalizedCode);
    if (!subscribers) {
      return;
    }

    for (const client of [...subscribers]) {
      sendMessage(client.socket, message);
      if (clearAfter) {
        clearSubscription(client);
      }
    }
  };

  const broadcastMatchRuntimeOutcome = (code: string, outcome: {
    matchState: MatchStatePayload | null;
    playerStates: MatchPlayerRealtimeStatePayload[];
    shotFired: ShotFiredPayload | null;
  }) => {
    if (outcome.matchState) {
      broadcast(code, {
        type: "match_state",
        state: outcome.matchState,
      });
    }

    for (const player of outcome.playerStates) {
      broadcast(code, {
        type: "player_state",
        player,
      });
    }

    if (outcome.shotFired) {
      broadcast(code, {
        type: "shot_fired",
        shot: outcome.shotFired,
      });
    }
  };

  const handleSocketClose = (client: RealtimeClient) => {
    const code = client.subscribedLobbyCode;
    const auth = client.auth;
    clearSubscription(client);
    clients.delete(client);

    if (!code || !auth || presenceByLobbyUser.has(makePresenceKey(auth.id, code))) {
      return;
    }

    const result = handleRealtimeDisconnect(db, config, auth.id, code);
    if (!result || !result.matchEndedReason) {
      return;
    }

    matchRuntime.destroyMatch(result.code);
    broadcast(result.code, {
      type: "match_ended",
      reason: result.matchEndedReason,
    });
    broadcast(result.code, {
      type: "lobby_state",
      lobby: result.lobby,
    });
  };

  return {
    registerRoutes(app) {
      app.get("/realtime", { websocket: true }, (socket, request) => {
        const origin = request.headers.origin;
        if (origin && !config.corsOrigins.includes(origin)) {
          sendMessage(socket, {
            type: "error",
            message: "Origin not allowed.",
          });
          socket.close(1008, "Origin not allowed");
          return;
        }

        const client: RealtimeClient = {
          socket,
          auth: null,
          subscribedLobbyCode: null,
        };
        clients.add(client);

        socket.on("message", (raw: RawData) => {
          try {
            const message = parseMessage(raw);

            if (message.type === "auth") {
              client.auth = authenticateToken(db, config, message.token);
              sendMessage(socket, { type: "auth_ok" });
              return;
            }

            if (!client.auth) {
              throw new HttpError(401, "Realtime authentication is required.");
            }

            if (message.type === "subscribe_lobby") {
              const requestedCode = normalizeLobbyCode(message.code);
              const currentLobby = getCurrentLobbyForUser(db, config, client.auth.id);
              if (!currentLobby || currentLobby.code !== requestedCode) {
                throw new HttpError(403, "You are not a member of that lobby.");
              }

              attachSubscription(client, requestedCode);
              sendMessage(socket, {
                type: "lobby_state",
                lobby: currentLobby,
              });
              const liveMatchState = matchRuntime.getMatchState(requestedCode);
              if (liveMatchState) {
                sendMessage(socket, {
                  type: "match_state",
                  state: liveMatchState,
                });
                for (const player of matchRuntime.getPlayerStates(requestedCode)) {
                  sendMessage(socket, {
                    type: "player_state",
                    player,
                  });
                }
              }
              return;
            }

            const subscribedCode = client.subscribedLobbyCode;
            if (!subscribedCode) {
              throw new HttpError(409, "Subscribe to a lobby before sending match messages.");
            }

            if (message.type === "player_state") {
              const outcome = matchRuntime.handlePlayerState(
                subscribedCode,
                client.auth.id,
                message,
                config.now(),
              );
              broadcastMatchRuntimeOutcome(subscribedCode, outcome);
              return;
            }

            if (message.type === "fire") {
              const outcome = matchRuntime.handleFire(
                subscribedCode,
                client.auth.id,
                message.shotId,
                message.weaponType,
                config.now(),
              );
              broadcastMatchRuntimeOutcome(subscribedCode, outcome);
              return;
            }

            const outcome = matchRuntime.handleReload(
              subscribedCode,
              client.auth.id,
              config.now(),
            );
            broadcastMatchRuntimeOutcome(subscribedCode, outcome);
          } catch (error) {
            const message = error instanceof HttpError
              ? error.message
              : "Realtime message failed.";
            sendMessage(socket, {
              type: "error",
              message,
            });
          }
        });

        socket.on("close", () => {
          handleSocketClose(client);
        });

        socket.on("error", () => {
          handleSocketClose(client);
        });
      });
    },

    close() {
      for (const client of [...clients]) {
        clearSubscription(client);
        const maybeSocket = client.socket as WebSocket & {
          socket?: {
            close?: () => void;
          };
          close?: () => void;
        };
        if (typeof maybeSocket.close === "function") {
          maybeSocket.close();
        } else {
          maybeSocket.socket?.close?.();
        }
      }
      clients.clear();
      subscriptionsByLobby.clear();
      presenceByLobbyUser.clear();
      matchRuntime.destroyAll();
    },

    isUserConnectedToLobby(userId, code) {
      return (presenceByLobbyUser.get(makePresenceKey(userId, code)) ?? 0) > 0;
    },

    initializeMatchRuntime(code, lobby) {
      return matchRuntime.createMatch(code, lobby);
    },

    broadcastMatchState(code, providedState) {
      const state = providedState === undefined
        ? matchRuntime.getMatchState(code)
        : providedState;
      if (!state) {
        return;
      }
      broadcast(code, {
        type: "match_state",
        state,
      });
    },

    broadcastLobbyState(code, providedLobby) {
      const lobby = providedLobby === undefined
        ? getLobbyPayloadByCodeOrNull(db, config, code)
        : providedLobby;
      broadcast(code, {
        type: "lobby_state",
        lobby,
      }, lobby === null);
    },

    broadcastMatchStarted(code, match) {
      broadcast(code, {
        type: "match_started",
        match,
      });
    },

    broadcastMatchEnded(code, reason) {
      matchRuntime.destroyMatch(code);
      broadcast(code, {
        type: "match_ended",
        reason,
      });
    },
  };
}
