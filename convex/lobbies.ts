import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type {
  ActiveMatchPayload,
  LobbyPayload,
  LobbyPlayer,
  MatchEndedReason,
} from "./domain";
import { HttpError } from "./lib/httpError";
import { createRoomCode } from "./lib/roomCode";
import { normalizeLobbyCode } from "./lib/validation";
import { LOBBY_TTL_MS, MAX_PLAYERS, PRESENCE_TTL_MS } from "./constants";
import { requireAuthMutation, requireAuthQuery } from "./sessionHelpers";

const MAX_PLAYERS_CONST = MAX_PLAYERS;
const HOSTED_MATCH_PROTOCOL_VERSION = 1;

function createExpiresAt(now: Date, ttlMs: number) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function assertOpenLobby(lobby: {
  status: "open" | "in_match";
}) {
  if (lobby.status !== "open") {
    throw new HttpError(409, "Lobby is already in a match.");
  }
}

function buildActiveMatch(
  lobby: {
    status: "open" | "in_match";
    matchStartedAt: string | null;
    hostUserId: Id<"users">;
    hostAddress: string | null;
    hostPort: number | null;
    protocolVersion: number | null;
  },
  players: LobbyPlayer[],
): ActiveMatchPayload | null {
  if (
    lobby.status !== "in_match" ||
    !lobby.matchStartedAt ||
    !lobby.hostAddress ||
    lobby.hostPort === null ||
    lobby.protocolVersion === null
  ) {
    return null;
  }

  return {
    startedAt: lobby.matchStartedAt,
    hostAddress: lobby.hostAddress,
    hostPort: lobby.hostPort,
    protocolVersion: lobby.protocolVersion,
    slots: buildActiveMatchSlots(lobby.hostUserId, players),
  };
}

function buildActiveMatchSlots(
  hostUserId: Id<"users">,
  players: LobbyPlayer[],
): ActiveMatchPayload["slots"] {
  const orderedPlayers = [...players].sort((left, right) => {
    if (left.userId === hostUserId && right.userId !== hostUserId) {
      return -1;
    }
    if (right.userId === hostUserId && left.userId !== hostUserId) {
      return 1;
    }
    return left.joinedAt.localeCompare(right.joinedAt);
  });

  return orderedPlayers.map((player, index) => ({
    userId: player.userId,
    slotIndex: index,
    selectedCharacterId: player.selectedCharacterId,
  }));
}

function normalizeHostedMatchAddress(rawAddress: string) {
  const hostAddress = rawAddress.trim();
  if (!hostAddress) {
    throw new HttpError(400, "Host address is required.");
  }
  if (hostAddress.length > 255) {
    throw new HttpError(400, "Host address is too long.");
  }
  return hostAddress;
}

function normalizeHostedMatchPort(rawPort: number) {
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65_535) {
    throw new HttpError(400, "Host port must be between 1 and 65535.");
  }
  return rawPort;
}

async function findLobbyPlayers(
  ctx: MutationCtx | QueryCtx,
  lobbyId: Id<"lobbies">,
): Promise<LobbyPlayer[]> {
  const lobby = await ctx.db.get(lobbyId);
  if (!lobby) {
    return [];
  }

  const members = await ctx.db
    .query("lobbyMembers")
    .withIndex("by_lobby_id", (q) => q.eq("lobbyId", lobbyId))
    .collect();

  const sorted = [...members].sort((left, right) =>
    left.joinedAt.localeCompare(right.joinedAt),
  );

  const players: LobbyPlayer[] = [];
  for (const member of sorted) {
    const user = await ctx.db.get(member.userId);
    if (!user) {
      continue;
    }
    players.push({
      userId: member.userId,
      username: user.username,
      isHost: member.userId === lobby.hostUserId,
      isReady: member.isReady,
      joinedAt: member.joinedAt,
      selectedCharacterId: member.selectedCharacterId,
    });
  }

  return players;
}

async function getLobbyPayloadById(
  ctx: MutationCtx | QueryCtx,
  lobbyId: Id<"lobbies">,
): Promise<LobbyPayload | null> {
  const lobby = await ctx.db.get(lobbyId);
  if (!lobby) {
    return null;
  }

  const players = await findLobbyPlayers(ctx, lobbyId);

  return {
    code: lobby.code,
    status: lobby.status,
    hostUserId: lobby.hostUserId,
    maxPlayers: MAX_PLAYERS_CONST,
    selectedMapId: lobby.selectedMapId,
    createdAt: lobby.createdAt,
    expiresAt: lobby.expiresAt,
    activeMatch: buildActiveMatch(lobby, players),
    lastMatchEndedReason: lobby.lastMatchEndedReason,
    players,
  };
}

async function findActiveMembership(
  ctx: MutationCtx | QueryCtx,
  userId: Id<"users">,
  nowIso: string,
) {
  const members = await ctx.db
    .query("lobbyMembers")
    .withIndex("by_user_id", (q) => q.eq("userId", userId))
    .collect();

  for (const member of members) {
    const lobby = await ctx.db.get(member.lobbyId);
    if (lobby && lobby.expiresAt > nowIso) {
      return { lobbyId: member.lobbyId, code: lobby.code };
    }
  }

  return undefined;
}

async function findLobbyByCode(
  ctx: MutationCtx | QueryCtx,
  rawCode: string,
  nowIso: string,
) {
  const code = normalizeLobbyCode(rawCode);
  const lobby = await ctx.db
    .query("lobbies")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();

  if (!lobby || lobby.expiresAt <= nowIso) {
    return undefined;
  }

  return lobby;
}

async function createUniqueRoomCode(ctx: MutationCtx) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = createRoomCode();
    const existing = await ctx.db
      .query("lobbies")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (!existing) {
      return code;
    }
  }

  throw new HttpError(500, "Failed to generate a lobby code.");
}

async function resetLobbyReadyStates(ctx: MutationCtx, lobbyId: Id<"lobbies">) {
  const members = await ctx.db
    .query("lobbyMembers")
    .withIndex("by_lobby_id", (q) => q.eq("lobbyId", lobbyId))
    .collect();

  for (const member of members) {
    await ctx.db.patch(member._id, { isReady: false });
  }
}

async function updateLobbyTimestamp(
  ctx: MutationCtx,
  lobbyId: Id<"lobbies">,
  now: Date,
) {
  const lobby = await ctx.db.get(lobbyId);
  if (!lobby) {
    return;
  }
  const nowIso = now.toISOString();
  await ctx.db.patch(lobbyId, {
    updatedAt: nowIso,
    expiresAt: createExpiresAt(now, LOBBY_TTL_MS),
  });
}

async function setLobbyOpen(
  ctx: MutationCtx,
  lobbyId: Id<"lobbies">,
  now: Date,
  reason: MatchEndedReason | null = null,
) {
  const lobby = await ctx.db.get(lobbyId);
  if (!lobby) {
    return;
  }
  const nowIso = now.toISOString();
  await ctx.db.patch(lobbyId, {
    status: "open",
    matchStartedAt: null,
    hostAddress: null,
    hostPort: null,
    protocolVersion: null,
    lastMatchEndedReason: reason,
    updatedAt: nowIso,
    expiresAt: createExpiresAt(now, LOBBY_TTL_MS),
  });
  await resetLobbyReadyStates(ctx, lobbyId);

  const runtime = await ctx.db
    .query("matchRuntimes")
    .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", lobby.code))
    .unique();
  if (runtime) {
    await ctx.db.delete(runtime._id);
  }
}

async function isUserPresent(
  ctx: MutationCtx,
  userId: Id<"users">,
  lobbyCode: string,
  nowMs: number,
) {
  const presence = await ctx.db
    .query("lobbyPresence")
    .withIndex("by_lobby_code_and_user_id", (q) =>
      q.eq("lobbyCode", lobbyCode).eq("userId", userId),
    )
    .unique();

  if (!presence) {
    return false;
  }
  return nowMs - presence.lastSeenAt <= PRESENCE_TTL_MS;
}

export const getCurrentLobby = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const auth = await requireAuthQuery(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const membership = await findActiveMembership(ctx, auth.userId, nowIso);
    if (!membership) {
      return { lobby: null as LobbyPayload | null };
    }
    const lobby = await getLobbyPayloadById(ctx, membership.lobbyId);
    return { lobby };
  },
});

export const getLobby = query({
  args: {
    sessionToken: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAuthQuery(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const lobbyRow = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobbyRow) {
      throw new HttpError(404, "Lobby not found.");
    }
    const lobby = await getLobbyPayloadById(ctx, lobbyRow._id);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    return lobby;
  },
});

export const leaveCurrentInternal = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const presenceRows = await ctx.db
      .query("lobbyPresence")
      .withIndex("by_user_id", (q) => q.eq("userId", args.userId))
      .collect();

    for (const row of presenceRows) {
      await ctx.db.delete(row._id);
    }

    const nowIso = new Date().toISOString();
    const membership = await findActiveMembership(ctx, args.userId, nowIso);
    if (!membership) {
      return null;
    }

    await leaveLobbyImpl(ctx, args.userId, membership.code, new Date());
    return null;
  },
});

async function leaveLobbyImpl(
  ctx: MutationCtx,
  userId: Id<"users">,
  rawCode: string,
  now: Date,
): Promise<{
  code: string;
  lobby: LobbyPayload | null;
  matchEndedReason: MatchEndedReason | null;
}> {
  const nowIso = now.toISOString();
  const lobby = await findLobbyByCode(ctx, rawCode, nowIso);
  if (!lobby) {
    throw new HttpError(404, "Lobby not found.");
  }

  const membership = await ctx.db
    .query("lobbyMembers")
    .withIndex("by_lobby_id_and_user_id", (q) =>
      q.eq("lobbyId", lobby._id).eq("userId", userId),
    )
    .unique();

  if (!membership) {
    throw new HttpError(404, "You are not in that lobby.");
  }

  const wasInMatch = lobby.status === "in_match";

  await ctx.db.delete(membership._id);

  const remaining = await ctx.db
    .query("lobbyMembers")
    .withIndex("by_lobby_id", (q) => q.eq("lobbyId", lobby._id))
    .collect();

  const remainingSorted = [...remaining].sort((left, right) =>
    left.joinedAt.localeCompare(right.joinedAt),
  );

  if (remainingSorted.length === 0) {
    const runtime = await ctx.db
      .query("matchRuntimes")
      .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", lobby.code))
      .unique();
    if (runtime) {
      await ctx.db.delete(runtime._id);
    }
    await ctx.db.delete(lobby._id);
    return {
      code: lobby.code,
      lobby: null,
      matchEndedReason: wasInMatch
        ? userId === lobby.hostUserId
          ? "host_left"
          : "player_left"
        : null,
    };
  }

  const nextHost =
    lobby.hostUserId === userId ? remainingSorted[0]!.userId : lobby.hostUserId;

  await ctx.db.patch(lobby._id, {
    hostUserId: nextHost,
    status: wasInMatch ? "open" : lobby.status,
    matchStartedAt: null,
    hostAddress: null,
    hostPort: null,
    protocolVersion: null,
    lastMatchEndedReason: wasInMatch
      ? (userId === lobby.hostUserId ? "host_left" : "player_left")
      : null,
    updatedAt: now.toISOString(),
    expiresAt: createExpiresAt(now, LOBBY_TTL_MS),
  });

  if (wasInMatch) {
    await resetLobbyReadyStates(ctx, lobby._id);
  }

  const runtime = await ctx.db
    .query("matchRuntimes")
    .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", lobby.code))
    .unique();
  if (runtime) {
    await ctx.db.delete(runtime._id);
  }

  return {
    code: lobby.code,
    lobby: await getLobbyPayloadById(ctx, lobby._id),
    matchEndedReason: wasInMatch
      ? userId === lobby.hostUserId
        ? "host_left"
        : "player_left"
      : null,
  };
}

export const createLobby = mutation({
  args: {
    sessionToken: v.string(),
    maxPlayers: v.literal(2),
    selectedCharacterId: v.string(),
    selectedMapId: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    if (args.maxPlayers !== MAX_PLAYERS_CONST) {
      throw new HttpError(400, "Only 2-player lobbies are supported right now.");
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const existingMembership = await findActiveMembership(ctx, auth.userId, nowIso);
    if (existingMembership) {
      throw new HttpError(409, "You are already in an active lobby.");
    }

    const code = await createUniqueRoomCode(ctx);

    await ctx.db.insert("lobbies", {
      code,
      hostUserId: auth.userId,
      status: "open",
      maxPlayers: MAX_PLAYERS_CONST,
      selectedMapId: args.selectedMapId,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: createExpiresAt(now, LOBBY_TTL_MS),
      matchStartedAt: null,
      hostAddress: null,
      hostPort: null,
      protocolVersion: null,
      lastMatchEndedReason: null,
    });

    const inserted = await ctx.db
      .query("lobbies")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!inserted) {
      throw new HttpError(500, "Lobby creation failed.");
    }

    await ctx.db.insert("lobbyMembers", {
      lobbyId: inserted._id,
      userId: auth.userId,
      isReady: false,
      selectedCharacterId: args.selectedCharacterId,
      joinedAt: nowIso,
    });

    return await getLobbyPayloadById(ctx, inserted._id);
  },
});

export const joinLobby = mutation({
  args: {
    sessionToken: v.string(),
    code: v.string(),
    selectedCharacterId: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const code = normalizeLobbyCode(args.code);

    const lobby = await findLobbyByCode(ctx, code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    assertOpenLobby(lobby);

    const currentMembership = await findActiveMembership(ctx, auth.userId, nowIso);
    if (currentMembership) {
      if (currentMembership.code === code) {
        return await getLobbyPayloadById(ctx, currentMembership.lobbyId);
      }
      throw new HttpError(409, "You are already in an active lobby.");
    }

    const refreshedLobby = await findLobbyByCode(ctx, code, nowIso);
    if (!refreshedLobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    assertOpenLobby(refreshedLobby);

    const members = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id", (q) => q.eq("lobbyId", refreshedLobby._id))
      .collect();

    if (members.length >= refreshedLobby.maxPlayers) {
      throw new HttpError(409, "Lobby is full.");
    }

    await ctx.db.insert("lobbyMembers", {
      lobbyId: refreshedLobby._id,
      userId: auth.userId,
      isReady: false,
      selectedCharacterId: args.selectedCharacterId,
      joinedAt: nowIso,
    });

    await ctx.db.patch(refreshedLobby._id, {
      updatedAt: nowIso,
      expiresAt: createExpiresAt(now, LOBBY_TTL_MS),
    });

    return await getLobbyPayloadById(ctx, refreshedLobby._id);
  },
});

export const setReady = mutation({
  args: {
    sessionToken: v.string(),
    code: v.string(),
    ready: v.boolean(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    assertOpenLobby(lobby);

    const member = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id_and_user_id", (q) =>
        q.eq("lobbyId", lobby._id).eq("userId", auth.userId),
      )
      .unique();

    if (!member) {
      throw new HttpError(404, "You are not in that lobby.");
    }

    await ctx.db.patch(member._id, { isReady: args.ready });
    await updateLobbyTimestamp(ctx, lobby._id, now);
    return await getLobbyPayloadById(ctx, lobby._id);
  },
});

export const setCharacter = mutation({
  args: {
    sessionToken: v.string(),
    code: v.string(),
    selectedCharacterId: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    assertOpenLobby(lobby);

    const member = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id_and_user_id", (q) =>
        q.eq("lobbyId", lobby._id).eq("userId", auth.userId),
      )
      .unique();

    if (!member) {
      throw new HttpError(404, "You are not in that lobby.");
    }

    await ctx.db.patch(member._id, {
      selectedCharacterId: args.selectedCharacterId,
      isReady: false,
    });
    await updateLobbyTimestamp(ctx, lobby._id, now);
    return await getLobbyPayloadById(ctx, lobby._id);
  },
});

export const setMap = mutation({
  args: {
    sessionToken: v.string(),
    code: v.string(),
    selectedMapId: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    assertOpenLobby(lobby);

    if (lobby.hostUserId !== auth.userId) {
      throw new HttpError(403, "Only the host can change the map.");
    }

    await ctx.db.patch(lobby._id, {
      selectedMapId: args.selectedMapId,
      updatedAt: nowIso,
      expiresAt: createExpiresAt(now, LOBBY_TTL_MS),
    });
    await resetLobbyReadyStates(ctx, lobby._id);
    return await getLobbyPayloadById(ctx, lobby._id);
  },
});

export const startMatch = mutation({
  args: {
    sessionToken: v.string(),
    code: v.string(),
    hostAddress: v.string(),
    hostPort: v.number(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const hostAddress = normalizeHostedMatchAddress(args.hostAddress);
    const hostPort = normalizeHostedMatchPort(args.hostPort);
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }
    assertOpenLobby(lobby);

    if (lobby.hostUserId !== auth.userId) {
      throw new HttpError(403, "Only the host can start the match.");
    }

    const players = await findLobbyPlayers(ctx, lobby._id);
    if (players.length !== 2) {
      throw new HttpError(409, "Both players must be in the lobby before starting.");
    }

    if (players.some((player) => !player.isReady)) {
      throw new HttpError(409, "Both players must be ready before starting.");
    }

    if (players.some((player) => !player.selectedCharacterId)) {
      throw new HttpError(409, "Both players must lock a character before starting.");
    }

    const normalizedCode = normalizeLobbyCode(lobby.code);
    for (const player of players) {
      const present = await isUserPresent(
        ctx,
        player.userId as Id<"users">,
        normalizedCode,
        nowMs,
      );
      if (!present) {
        throw new HttpError(
          409,
          "Both players must be connected to realtime before starting.",
        );
      }
    }

    if (lobby.selectedMapId !== "map1") {
      throw new HttpError(
        409,
        "Live multiplayer combat is only wired for map1 right now.",
      );
    }

    await ctx.db.patch(lobby._id, {
      status: "in_match",
      matchStartedAt: nowIso,
      hostAddress,
      hostPort,
      protocolVersion: HOSTED_MATCH_PROTOCOL_VERSION,
      lastMatchEndedReason: null,
      updatedAt: nowIso,
      expiresAt: createExpiresAt(now, LOBBY_TTL_MS),
    });

    return { ok: true as const };
  },
});

export const endMatch = mutation({
  args: { sessionToken: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }

    const membership = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id_and_user_id", (q) =>
        q.eq("lobbyId", lobby._id).eq("userId", auth.userId),
      )
      .unique();

    if (!membership) {
      throw new HttpError(404, "You are not in that lobby.");
    }

    if (lobby.status === "open") {
      return {
        ok: true as const,
        code: lobby.code,
        lobby: await getLobbyPayloadById(ctx, lobby._id),
        matchEndedReason: null as MatchEndedReason | null,
      };
    }

    const matchEndedReason =
      auth.userId === lobby.hostUserId ? "host_ended_match" : "player_ended_match";

    await setLobbyOpen(ctx, lobby._id, now, matchEndedReason);

    return {
      ok: true as const,
      code: lobby.code,
      lobby: await getLobbyPayloadById(ctx, lobby._id),
      matchEndedReason,
    };
  },
});

export const finalizeHostedMatch = mutation({
  args: {
    sessionToken: v.string(),
    code: v.string(),
    reason: v.union(
      v.literal("host_disconnected"),
      v.literal("player_disconnected"),
      v.literal("host_left"),
      v.literal("player_left"),
      v.literal("host_ended_match"),
      v.literal("player_ended_match"),
    ),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }

    const membership = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id_and_user_id", (q) =>
        q.eq("lobbyId", lobby._id).eq("userId", auth.userId),
      )
      .unique();

    if (!membership) {
      throw new HttpError(404, "You are not in that lobby.");
    }

    if (lobby.status === "open") {
      return {
        ok: true as const,
        code: lobby.code,
        lobby: await getLobbyPayloadById(ctx, lobby._id),
        matchEndedReason: lobby.lastMatchEndedReason,
      };
    }

    await setLobbyOpen(ctx, lobby._id, now, args.reason);

    return {
      ok: true as const,
      code: lobby.code,
      lobby: await getLobbyPayloadById(ctx, lobby._id),
      matchEndedReason: args.reason as MatchEndedReason,
    };
  },
});

export const leaveLobby = mutation({
  args: { sessionToken: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const result = await leaveLobbyImpl(ctx, auth.userId, args.code, new Date());
    return { ok: true as const, ...result };
  },
});

export const disbandLobby = mutation({
  args: { sessionToken: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby) {
      throw new HttpError(404, "Lobby not found.");
    }

    if (lobby.hostUserId !== auth.userId) {
      throw new HttpError(403, "Only the host can disband the lobby.");
    }

    const members = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id", (q) => q.eq("lobbyId", lobby._id))
      .collect();

    for (const member of members) {
      await ctx.db.delete(member._id);
    }

    const runtime = await ctx.db
      .query("matchRuntimes")
      .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", lobby.code))
      .unique();
    if (runtime) {
      await ctx.db.delete(runtime._id);
    }

    await ctx.db.delete(lobby._id);

    return {
      ok: true as const,
      code: lobby.code,
      lobby: null,
      matchEndedReason: lobby.status === "in_match" ? ("host_left" as const) : null,
    };
  },
});

export const handleDisconnect = mutation({
  args: { sessionToken: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const now = new Date();
    const nowIso = now.toISOString();
    const lobby = await findLobbyByCode(ctx, args.code, nowIso);
    if (!lobby || lobby.status !== "in_match") {
      return null;
    }

    const membership = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id_and_user_id", (q) =>
        q.eq("lobbyId", lobby._id).eq("userId", auth.userId),
      )
      .unique();

    if (!membership) {
      return null;
    }

    const matchEndedReason =
      auth.userId === lobby.hostUserId ? "host_disconnected" : "player_disconnected";
    await setLobbyOpen(ctx, lobby._id, now, matchEndedReason);

    return {
      code: lobby.code,
      lobby: await getLobbyPayloadById(ctx, lobby._id),
      matchEndedReason,
    };
  },
});
