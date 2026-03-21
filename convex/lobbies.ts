import {
  MAX_LOBBY_PLAYERS,
  PROBE_WINDOW_MS,
  expectedProbeReportCount,
  reportProbeInputSchema,
  selectHostCandidate,
} from "../packages/contracts/src";
import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { authComponent } from "./auth";
import { ensureCurrentUserProfile } from "./lib/auth";
import { abortLobbyMatch } from "./lib/matches";
import {
  buildLobbyView,
  getLobbyByCodeDoc,
  getMemberByUserId,
  listLobbyMemberDocs,
  nextOpenSlot,
  resetMemberState,
  reserveUniqueLobbyCode,
} from "./lib/lobbies";

export const createLobby = mutation({
  args: {
    mapId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const now = Date.now();
    const code = await reserveUniqueLobbyCode(ctx);
    const lobbyId = await ctx.db.insert("lobbies", {
      code,
      status: "forming",
      mode: "tdm",
      mapId: args.mapId,
      maxPlayers: MAX_LOBBY_PLAYERS,
      ownerUserId: user.authUserId,
      hostUserId: null,
      matchId: null,
      probeDeadlineAt: null,
      createdAt: now,
    });

    await ctx.db.insert("lobbyMembers", {
      lobbyId,
      userId: user.authUserId,
      slot: 0,
      ready: false,
      team: null,
      joinedAt: now,
      connectionState: "connected",
    });

    const lobby = await ctx.db.get(lobbyId);
    if (!lobby) {
      throw new ConvexError("Lobby creation failed");
    }

    return await buildLobbyView(ctx, lobby);
  },
});

export const getLobbyByCode = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    await authComponent.getAuthUser(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    return {
      id: lobby._id,
      code: lobby.code,
      status: lobby.status,
      mode: lobby.mode,
      mapId: lobby.mapId,
      maxPlayers: lobby.maxPlayers,
      ownerUserId: lobby.ownerUserId,
      hostUserId: lobby.hostUserId,
      matchId: lobby.matchId,
      createdAt: lobby.createdAt,
    };
  },
});

export const listLobbyMembers = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    await authComponent.getAuthUser(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    return (await buildLobbyView(ctx, lobby)).members;
  },
});

export const getLobbyView = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    await authComponent.getAuthUser(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    return await buildLobbyView(ctx, lobby);
  },
});

export const joinLobby = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    if (lobby.status !== "forming") {
      throw new ConvexError("Lobby is not accepting joins");
    }

    const members = await listLobbyMemberDocs(ctx, lobby._id);
    const existingMember = getMemberByUserId(members, user.authUserId);

    if (existingMember) {
      await ctx.db.patch(existingMember._id, {
        connectionState: "connected",
      });
      const refreshedLobby = await ctx.db.get(lobby._id);
      if (!refreshedLobby) {
        throw new ConvexError("Lobby not found");
      }
      return await buildLobbyView(ctx, refreshedLobby);
    }

    if (members.length >= MAX_LOBBY_PLAYERS) {
      throw new ConvexError("Lobby is full");
    }

    await ctx.db.insert("lobbyMembers", {
      lobbyId: lobby._id,
      userId: user.authUserId,
      slot: nextOpenSlot(members),
      ready: false,
      team: null,
      joinedAt: Date.now(),
      connectionState: "connected",
    });

    const nextMembers = await listLobbyMemberDocs(ctx, lobby._id);
    await resetMemberState(ctx, nextMembers, {
      ready: false,
      clearTeams: true,
    });

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }
    return await buildLobbyView(ctx, refreshedLobby);
  },
});

export const leaveLobby = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    if (lobby.status === "match_live") {
      throw new ConvexError("Cannot leave a live match through lobby leave");
    }

    const members = await listLobbyMemberDocs(ctx, lobby._id);
    const member = getMemberByUserId(members, user.authUserId);
    if (!member) {
      throw new ConvexError("User is not in the lobby");
    }

    await ctx.db.delete(member._id);
    const remainingMembers = await listLobbyMemberDocs(ctx, lobby._id);

    if (remainingMembers.length === 0) {
      await ctx.db.patch(lobby._id, {
        status: "closed",
        ownerUserId: lobby.ownerUserId,
        hostUserId: null,
        matchId: null,
        probeDeadlineAt: null,
      });
    } else {
      const nextOwner =
        remainingMembers.sort((left, right) => left.joinedAt - right.joinedAt)[0]
          ?.userId ?? lobby.ownerUserId;
      await resetMemberState(ctx, remainingMembers, {
        ready: false,
        clearTeams: true,
      });
      await ctx.db.patch(lobby._id, {
        ownerUserId: nextOwner,
        hostUserId:
          lobby.hostUserId && lobby.hostUserId !== user.authUserId
            ? lobby.hostUserId
            : null,
        probeDeadlineAt: null,
      });
    }

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }
    return await buildLobbyView(ctx, refreshedLobby);
  },
});

export const setReady = mutation({
  args: {
    code: v.string(),
    ready: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    if (lobby.status !== "forming") {
      throw new ConvexError("Lobby is not in a ready state");
    }

    const members = await listLobbyMemberDocs(ctx, lobby._id);
    const member = getMemberByUserId(members, user.authUserId);
    if (!member) {
      throw new ConvexError("User is not in the lobby");
    }

    await ctx.db.patch(member._id, {
      ready: args.ready,
    });

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }
    return await buildLobbyView(ctx, refreshedLobby);
  },
});

export const startProbe = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    if (lobby.status !== "forming") {
      throw new ConvexError("Lobby is not ready for probing");
    }

    const members = await listLobbyMemberDocs(ctx, lobby._id);
    if (!getMemberByUserId(members, user.authUserId)) {
      throw new ConvexError("User is not in the lobby");
    }

    if (members.length !== MAX_LOBBY_PLAYERS) {
      throw new ConvexError("Exactly six players are required to start probing");
    }

    if (
      members.some(
        (member) =>
          member.connectionState !== "connected" ||
          member.ready !== true,
      )
    ) {
      throw new ConvexError("All lobby members must be connected and ready");
    }

    const existingProbeResults = await ctx.db
      .query("probeResults")
      .withIndex("by_lobbyId", (query) => query.eq("lobbyId", lobby._id))
      .collect();

    await Promise.all(
      existingProbeResults.map(async (probeResult) => {
        await ctx.db.delete(probeResult._id);
      }),
    );

    await ctx.db.patch(lobby._id, {
      status: "probing",
      hostUserId: null,
      probeDeadlineAt: Date.now() + PROBE_WINDOW_MS,
    });

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }
    return await buildLobbyView(ctx, refreshedLobby);
  },
});

export const storeProbeResult = mutation({
  args: {
    code: v.string(),
    targetUserId: v.string(),
    medianRttMs: v.number(),
    maxRttMs: v.number(),
    jitterMs: v.number(),
    lossPct: v.number(),
  },
  handler: async (ctx, args) => {
    const parsed = reportProbeInputSchema.safeParse(args);
    if (!parsed.success) {
      throw new ConvexError(parsed.error.flatten().fieldErrors);
    }

    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    if (lobby.status !== "probing") {
      throw new ConvexError("Lobby is not accepting probe results");
    }

    const members = await listLobbyMemberDocs(ctx, lobby._id);
    if (!getMemberByUserId(members, user.authUserId)) {
      throw new ConvexError("User is not in the lobby");
    }

    if (user.authUserId === args.targetUserId) {
      throw new ConvexError("Users cannot report probe results against themselves");
    }

    if (!getMemberByUserId(members, args.targetUserId)) {
      throw new ConvexError("Probe target is not in the lobby");
    }

    const existing = await ctx.db
      .query("probeResults")
      .withIndex("by_lobbyId", (query) => query.eq("lobbyId", lobby._id))
      .collect()
      .then((results) =>
        results.find(
          (result) =>
            result.sourceUserId === user.authUserId &&
            result.targetUserId === args.targetUserId,
        ) ?? null,
      );

    const payload = {
      lobbyId: lobby._id,
      sourceUserId: user.authUserId,
      targetUserId: args.targetUserId,
      medianRttMs: args.medianRttMs,
      maxRttMs: args.maxRttMs,
      jitterMs: args.jitterMs,
      lossPct: args.lossPct,
      sampledAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
    } else {
      await ctx.db.insert("probeResults", payload);
    }

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }
    return await buildLobbyView(ctx, refreshedLobby);
  },
});

export const selectHost = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    const members = await listLobbyMemberDocs(ctx, lobby._id);

    if (!getMemberByUserId(members, user.authUserId)) {
      throw new ConvexError("User is not in the lobby");
    }

    if (lobby.status !== "probing") {
      throw new ConvexError("Lobby is not in probe mode");
    }

    if (members.length !== MAX_LOBBY_PLAYERS) {
      throw new ConvexError("Lobby must still have six players");
    }

    const probeResults = await ctx.db
      .query("probeResults")
      .withIndex("by_lobbyId", (query) => query.eq("lobbyId", lobby._id))
      .collect();

    if (probeResults.length !== expectedProbeReportCount(MAX_LOBBY_PLAYERS)) {
      throw new ConvexError("Probe result matrix is incomplete");
    }

    const { hostUserId, scores } = selectHostCandidate({
      candidates: members.map((member) => ({
        userId: member.userId,
        joinedAt: member.joinedAt,
      })),
      probes: probeResults.map((probe) => ({
        sourceUserId: probe.sourceUserId,
        targetUserId: probe.targetUserId,
        medianRttMs: probe.medianRttMs,
        maxRttMs: probe.maxRttMs,
        jitterMs: probe.jitterMs,
        lossPct: probe.lossPct,
      })),
    });

    await ctx.db.patch(lobby._id, {
      hostUserId,
    });

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }

    return {
      lobby: await buildLobbyView(ctx, refreshedLobby),
      scores,
    };
  },
});

export const upsertPresence = mutation({
  args: {
    lobbyCode: v.optional(v.string()),
    connectionState: v.optional(
      v.union(v.literal("connected"), v.literal("disconnected")),
    ),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);

    if (!args.lobbyCode || !args.connectionState) {
      return user;
    }

    const lobby = await getLobbyByCodeDoc(ctx, args.lobbyCode);
    const members = await listLobbyMemberDocs(ctx, lobby._id);
    const member = getMemberByUserId(members, user.authUserId);

    if (!member) {
      return user;
    }

    await ctx.db.patch(member._id, {
      connectionState: args.connectionState,
    });

    if (
      args.connectionState === "disconnected" &&
      lobby.status === "match_live" &&
      lobby.hostUserId === user.authUserId
    ) {
      await abortLobbyMatch(
        ctx,
        lobby,
        "The host disconnected. Match aborted and lobby reset.",
      );
    }

    return user;
  },
});

export const closeLobby = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    if (lobby.ownerUserId !== user.authUserId) {
      throw new ConvexError("Only the lobby owner can close the lobby");
    }

    const members = await listLobbyMemberDocs(ctx, lobby._id);
    await Promise.all(
      members.map(async (member) => {
        await ctx.db.delete(member._id);
      }),
    );

    await ctx.db.patch(lobby._id, {
      status: "closed",
      hostUserId: null,
      matchId: null,
      probeDeadlineAt: null,
    });

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }
    return await buildLobbyView(ctx, refreshedLobby);
  },
});
