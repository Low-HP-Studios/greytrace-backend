import { and, asc, eq, lte } from "drizzle-orm";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/client.js";
import { lobbies, lobbyMembers, users } from "./db/schema.js";
import type {
  ActiveMatchPayload,
  LobbyPayload,
  LobbyPlayer,
  MatchEndedReason,
} from "./domain.js";
import { HttpError } from "./errors.js";
import { createId, createRoomCode } from "./security.js";

const MAX_PLAYERS = 2 as const;

function createExpiresAt(now: Date, ttlMs: number) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

type ActiveMembership = {
  lobbyId: string;
  code: string;
};

type LobbyRow = {
  id: string;
  code: string;
  hostUserId: string;
  status: "open" | "in_match";
  maxPlayers: number;
  selectedMapId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  matchStartedAt: string | null;
};

type LobbyMutationResult = {
  code: string;
  lobby: LobbyPayload | null;
  matchEndedReason: MatchEndedReason | null;
};

function normalizeLobbyCode(code: string) {
  return code.trim().toUpperCase();
}

function assertOpenLobby(lobby: LobbyRow) {
  if (lobby.status !== "open") {
    throw new HttpError(409, "Lobby is already in a match.");
  }
}

function buildActiveMatch(
  lobby: LobbyRow,
  players: LobbyPlayer[],
): ActiveMatchPayload | null {
  if (lobby.status !== "in_match" || !lobby.matchStartedAt) {
    return null;
  }

  const hostPlayer = players.find((player) => player.userId === lobby.hostUserId);
  const guestPlayer = players.find((player) => player.userId !== lobby.hostUserId);
  const slots = [];

  if (hostPlayer) {
    slots.push({
      userId: hostPlayer.userId,
      spawnSlot: "host" as const,
      selectedCharacterId: hostPlayer.selectedCharacterId,
    });
  }

  if (guestPlayer) {
    slots.push({
      userId: guestPlayer.userId,
      spawnSlot: "guest" as const,
      selectedCharacterId: guestPlayer.selectedCharacterId,
    });
  }

  return {
    startedAt: lobby.matchStartedAt,
    slots,
  };
}

function findActiveMembership(db: AppDatabase, userId: string) {
  return db.select({
    lobbyId: lobbyMembers.lobbyId,
    code: lobbies.code,
  })
    .from(lobbyMembers)
    .innerJoin(lobbies, eq(lobbyMembers.lobbyId, lobbies.id))
    .where(eq(lobbyMembers.userId, userId))
    .get() as ActiveMembership | undefined;
}

function findLobbyByCode(db: AppDatabase, rawCode: string) {
  const code = normalizeLobbyCode(rawCode);
  return db.select({
    id: lobbies.id,
    code: lobbies.code,
    hostUserId: lobbies.hostUserId,
    status: lobbies.status,
    maxPlayers: lobbies.maxPlayers,
    selectedMapId: lobbies.selectedMapId,
    createdAt: lobbies.createdAt,
    updatedAt: lobbies.updatedAt,
    expiresAt: lobbies.expiresAt,
    matchStartedAt: lobbies.matchStartedAt,
  })
    .from(lobbies)
    .where(eq(lobbies.code, code))
    .get() as LobbyRow | undefined;
}

function findLobbyPlayers(db: AppDatabase, lobbyId: string): LobbyPlayer[] {
  const lobby = db.select({
    hostUserId: lobbies.hostUserId,
  })
    .from(lobbies)
    .where(eq(lobbies.id, lobbyId))
    .get();

  if (!lobby) {
    return [];
  }

  const players = db.select({
    userId: users.id,
    username: users.username,
    isReady: lobbyMembers.isReady,
    joinedAt: lobbyMembers.joinedAt,
    selectedCharacterId: lobbyMembers.selectedCharacterId,
  })
    .from(lobbyMembers)
    .innerJoin(users, eq(lobbyMembers.userId, users.id))
    .where(eq(lobbyMembers.lobbyId, lobbyId))
    .orderBy(asc(lobbyMembers.joinedAt))
    .all();

  return players.map((player) => ({
    userId: player.userId,
    username: player.username,
    isHost: player.userId === lobby.hostUserId,
    isReady: player.isReady,
    joinedAt: player.joinedAt,
    selectedCharacterId: player.selectedCharacterId,
  }));
}

function createUniqueRoomCode(db: AppDatabase) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = createRoomCode();
    const existing = db.select({ id: lobbies.id })
      .from(lobbies)
      .where(eq(lobbies.code, code))
      .get();

    if (!existing) {
      return code;
    }
  }

  throw new HttpError(500, "Failed to generate a lobby code.");
}

function resetLobbyReadyStates(db: AppDatabase, lobbyId: string) {
  db.update(lobbyMembers)
    .set({ isReady: false })
    .where(eq(lobbyMembers.lobbyId, lobbyId))
    .run();
}

function updateLobbyTimestamp(db: AppDatabase, config: AppConfig, lobbyId: string) {
  const now = config.now();
  db.update(lobbies)
    .set({
      updatedAt: now.toISOString(),
      expiresAt: createExpiresAt(now, config.lobbyTtlMs),
    })
    .where(eq(lobbies.id, lobbyId))
    .run();
}

function setLobbyOpen(db: AppDatabase, config: AppConfig, lobbyId: string) {
  const now = config.now();
  db.update(lobbies)
    .set({
      status: "open",
      matchStartedAt: null,
      updatedAt: now.toISOString(),
      expiresAt: createExpiresAt(now, config.lobbyTtlMs),
    })
    .where(eq(lobbies.id, lobbyId))
    .run();
  resetLobbyReadyStates(db, lobbyId);
}

export function clearExpiredLobbies(db: AppDatabase, nowIso: string) {
  db.delete(lobbies).where(lte(lobbies.expiresAt, nowIso)).run();
}

export function getLobbyPayloadById(db: AppDatabase, lobbyId: string): LobbyPayload | null {
  const lobby = db.select({
    id: lobbies.id,
    code: lobbies.code,
    status: lobbies.status,
    hostUserId: lobbies.hostUserId,
    maxPlayers: lobbies.maxPlayers,
    selectedMapId: lobbies.selectedMapId,
    createdAt: lobbies.createdAt,
    expiresAt: lobbies.expiresAt,
    matchStartedAt: lobbies.matchStartedAt,
  })
    .from(lobbies)
    .where(eq(lobbies.id, lobbyId))
    .get() as LobbyRow | undefined;

  if (!lobby) {
    return null;
  }

  const players = findLobbyPlayers(db, lobbyId);

  return {
    code: lobby.code,
    status: lobby.status,
    hostUserId: lobby.hostUserId,
    maxPlayers: MAX_PLAYERS,
    selectedMapId: lobby.selectedMapId,
    createdAt: lobby.createdAt,
    expiresAt: lobby.expiresAt,
    activeMatch: buildActiveMatch(lobby, players),
    players,
  };
}

export function getLobbyPayloadByCodeOrNull(
  db: AppDatabase,
  config: AppConfig,
  rawCode: string,
) {
  clearExpiredLobbies(db, config.now().toISOString());
  const lobby = findLobbyByCode(db, rawCode);
  return lobby ? getLobbyPayloadById(db, lobby.id) : null;
}

export function getCurrentLobbyForUser(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
) {
  clearExpiredLobbies(db, config.now().toISOString());
  const membership = findActiveMembership(db, userId);
  return membership ? getLobbyPayloadById(db, membership.lobbyId) : null;
}

export function createLobby(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  maxPlayers: number,
  selectedCharacterId: string,
  selectedMapId: string,
) {
  if (maxPlayers !== MAX_PLAYERS) {
    throw new HttpError(400, "Only 2-player lobbies are supported right now.");
  }

  clearExpiredLobbies(db, config.now().toISOString());

  const lobbyId = db.transaction((tx) => {
    const currentMembership = findActiveMembership(tx as AppDatabase, userId);
    if (currentMembership) {
      throw new HttpError(409, "You are already in an active lobby.");
    }

    const now = config.now();
    const nowIso = now.toISOString();
    const lobbyIdValue = createId();

    tx.insert(lobbies).values({
      id: lobbyIdValue,
      code: createUniqueRoomCode(tx as AppDatabase),
      hostUserId: userId,
      status: "open",
      maxPlayers: MAX_PLAYERS,
      selectedMapId,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: createExpiresAt(now, config.lobbyTtlMs),
      matchStartedAt: null,
    }).run();

    tx.insert(lobbyMembers).values({
      lobbyId: lobbyIdValue,
      userId,
      isReady: false,
      selectedCharacterId,
      joinedAt: nowIso,
    }).run();

    return lobbyIdValue;
  });

  return getLobbyPayloadById(db, lobbyId);
}

export function joinLobby(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
  selectedCharacterId: string,
) {
  clearExpiredLobbies(db, config.now().toISOString());

  const code = normalizeLobbyCode(rawCode);
  const lobby = findLobbyByCode(db, code);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }
  assertOpenLobby(lobby);

  const currentMembership = findActiveMembership(db, userId);
  if (currentMembership) {
    if (currentMembership.code === code) {
      return getLobbyPayloadById(db, currentMembership.lobbyId);
    }

    throw new HttpError(409, "You are already in an active lobby.");
  }

  db.transaction((tx) => {
    const refreshedLobby = findLobbyByCode(tx as AppDatabase, code);
    if (!refreshedLobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    assertOpenLobby(refreshedLobby);

    const memberCount = tx.select({ userId: lobbyMembers.userId })
      .from(lobbyMembers)
      .where(eq(lobbyMembers.lobbyId, refreshedLobby.id))
      .all()
      .length;

    if (memberCount >= refreshedLobby.maxPlayers) {
      throw new HttpError(409, "Lobby is full.");
    }

    const now = config.now();
    const nowIso = now.toISOString();

    tx.insert(lobbyMembers).values({
      lobbyId: refreshedLobby.id,
      userId,
      isReady: false,
      selectedCharacterId,
      joinedAt: nowIso,
    }).run();

    tx.update(lobbies)
      .set({
        updatedAt: nowIso,
        expiresAt: createExpiresAt(now, config.lobbyTtlMs),
      })
      .where(eq(lobbies.id, refreshedLobby.id))
      .run();
  });

  return getLobbyPayloadById(db, lobby.id);
}

export function setReadyState(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
  ready: boolean,
) {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }
  assertOpenLobby(lobby);

  const updateResult = db.update(lobbyMembers)
    .set({ isReady: ready })
    .where(and(eq(lobbyMembers.lobbyId, lobby.id), eq(lobbyMembers.userId, userId)))
    .run();

  if (updateResult.changes === 0) {
    throw new HttpError(404, "You are not in that lobby.");
  }

  updateLobbyTimestamp(db, config, lobby.id);
  return getLobbyPayloadById(db, lobby.id);
}

export function setLobbyCharacter(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
  selectedCharacterId: string,
) {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }
  assertOpenLobby(lobby);

  const updateResult = db.update(lobbyMembers)
    .set({
      selectedCharacterId,
      isReady: false,
    })
    .where(and(eq(lobbyMembers.lobbyId, lobby.id), eq(lobbyMembers.userId, userId)))
    .run();

  if (updateResult.changes === 0) {
    throw new HttpError(404, "You are not in that lobby.");
  }

  updateLobbyTimestamp(db, config, lobby.id);
  return getLobbyPayloadById(db, lobby.id);
}

export function setLobbyMap(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
  selectedMapId: string,
) {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }
  assertOpenLobby(lobby);

  if (lobby.hostUserId !== userId) {
    throw new HttpError(403, "Only the host can change the map.");
  }

  const now = config.now();
  const nowIso = now.toISOString();
  db.transaction((tx) => {
    tx.update(lobbies)
      .set({
        selectedMapId,
        updatedAt: nowIso,
        expiresAt: createExpiresAt(now, config.lobbyTtlMs),
      })
      .where(eq(lobbies.id, lobby.id))
      .run();
    resetLobbyReadyStates(tx as AppDatabase, lobby.id);
  });

  return getLobbyPayloadById(db, lobby.id);
}

export function startMatch(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
  isUserConnectedToLobby: (memberUserId: string, code: string) => boolean,
) {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }
  assertOpenLobby(lobby);

  if (lobby.hostUserId !== userId) {
    throw new HttpError(403, "Only the host can start the match.");
  }

  const players = findLobbyPlayers(db, lobby.id);
  if (players.length !== 2) {
    throw new HttpError(409, "Both players must be in the lobby before starting.");
  }

  if (players.some((player) => !player.isReady)) {
    throw new HttpError(409, "Both players must be ready before starting.");
  }

  if (players.some((player) => !player.selectedCharacterId)) {
    throw new HttpError(409, "Both players must lock a character before starting.");
  }

  if (players.some((player) => !isUserConnectedToLobby(player.userId, lobby.code))) {
    throw new HttpError(409, "Both players must be connected to realtime before starting.");
  }

  if (lobby.selectedMapId !== "map1") {
    throw new HttpError(409, "Live multiplayer combat is only wired for map1 right now.");
  }

  const now = config.now();
  db.update(lobbies)
    .set({
      status: "in_match",
      matchStartedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: createExpiresAt(now, config.lobbyTtlMs),
    })
    .where(eq(lobbies.id, lobby.id))
    .run();

  return getLobbyPayloadById(db, lobby.id);
}

export function endMatch(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
): LobbyMutationResult {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }

  const membership = db.select({ userId: lobbyMembers.userId })
    .from(lobbyMembers)
    .where(and(eq(lobbyMembers.lobbyId, lobby.id), eq(lobbyMembers.userId, userId)))
    .get();

  if (!membership) {
    throw new HttpError(404, "You are not in that lobby.");
  }

  if (lobby.status === "open") {
    return {
      code: lobby.code,
      lobby: getLobbyPayloadById(db, lobby.id),
      matchEndedReason: null,
    };
  }

  setLobbyOpen(db, config, lobby.id);
  return {
    code: lobby.code,
    lobby: getLobbyPayloadById(db, lobby.id),
    matchEndedReason: userId === lobby.hostUserId ? "host_ended_match" : "player_ended_match",
  };
}

export function leaveLobby(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
): LobbyMutationResult {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }

  const result = db.transaction((tx) => {
    const membership = tx.select({ userId: lobbyMembers.userId })
      .from(lobbyMembers)
      .where(and(eq(lobbyMembers.lobbyId, lobby.id), eq(lobbyMembers.userId, userId)))
      .get();

    if (!membership) {
      throw new HttpError(404, "You are not in that lobby.");
    }

    const wasInMatch = lobby.status === "in_match";

    tx.delete(lobbyMembers)
      .where(and(eq(lobbyMembers.lobbyId, lobby.id), eq(lobbyMembers.userId, userId)))
      .run();

    const remainingMembers = tx.select({
      userId: lobbyMembers.userId,
      joinedAt: lobbyMembers.joinedAt,
    })
      .from(lobbyMembers)
      .where(eq(lobbyMembers.lobbyId, lobby.id))
      .orderBy(asc(lobbyMembers.joinedAt))
      .all();

    if (remainingMembers.length === 0) {
      tx.delete(lobbies).where(eq(lobbies.id, lobby.id)).run();
      return {
        code: lobby.code,
        lobby: null,
        matchEndedReason: wasInMatch
          ? (userId === lobby.hostUserId ? "host_left" : "player_left")
          : null,
      } satisfies LobbyMutationResult;
    }

    const now = config.now();
    tx.update(lobbies)
      .set({
        hostUserId: lobby.hostUserId === userId ? remainingMembers[0].userId : lobby.hostUserId,
        status: wasInMatch ? "open" : lobby.status,
        matchStartedAt: null,
        updatedAt: now.toISOString(),
        expiresAt: createExpiresAt(now, config.lobbyTtlMs),
      })
      .where(eq(lobbies.id, lobby.id))
      .run();

    if (wasInMatch) {
      resetLobbyReadyStates(tx as AppDatabase, lobby.id);
    }

    return {
      code: lobby.code,
      lobby: getLobbyPayloadById(tx as AppDatabase, lobby.id),
      matchEndedReason: wasInMatch
        ? (userId === lobby.hostUserId ? "host_left" : "player_left")
        : null,
    } satisfies LobbyMutationResult;
  });

  return result;
}

export function leaveCurrentLobbyForUser(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
) {
  const membership = findActiveMembership(db, userId);
  if (!membership) {
    return null;
  }

  return leaveLobby(db, config, userId, membership.code);
}

export function disbandLobby(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
): LobbyMutationResult {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }

  if (lobby.hostUserId !== userId) {
    throw new HttpError(403, "Only the host can disband the lobby.");
  }

  db.delete(lobbies).where(eq(lobbies.id, lobby.id)).run();

  return {
    code: lobby.code,
    lobby: null,
    matchEndedReason: lobby.status === "in_match" ? "host_left" : null,
  };
}

export function getLobbyByCode(
  db: AppDatabase,
  config: AppConfig,
  rawCode: string,
) {
  const lobby = getLobbyPayloadByCodeOrNull(db, config, rawCode);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }

  return lobby;
}

export function handleRealtimeDisconnect(
  db: AppDatabase,
  config: AppConfig,
  userId: string,
  rawCode: string,
): LobbyMutationResult | null {
  clearExpiredLobbies(db, config.now().toISOString());

  const lobby = findLobbyByCode(db, rawCode);
  if (!lobby || lobby.status !== "in_match") {
    return null;
  }

  const membership = db.select({ userId: lobbyMembers.userId })
    .from(lobbyMembers)
    .where(and(eq(lobbyMembers.lobbyId, lobby.id), eq(lobbyMembers.userId, userId)))
    .get();

  if (!membership) {
    return null;
  }

  setLobbyOpen(db, config, lobby.id);
  return {
    code: lobby.code,
    lobby: getLobbyPayloadById(db, lobby.id),
    matchEndedReason: userId === lobby.hostUserId
      ? "host_disconnected"
      : "player_disconnected",
  };
}
