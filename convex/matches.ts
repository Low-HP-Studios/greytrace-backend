import {
  MAX_LOBBY_PLAYERS,
  appendMatchEventsInputSchema,
  assignTeams,
  selectHostCandidate,
} from "../packages/contracts/src";
import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { authComponent } from "./auth";
import { ensureCurrentUserProfile } from "./lib/auth";
import { abortLobbyMatch, buildMatchView, listMatchPlayerDocs } from "./lib/matches";
import { buildLobbyView, getLobbyByCodeDoc, listLobbyMemberDocs } from "./lib/lobbies";

export const getMatchView = query({
  args: {
    matchId: v.id("matches"),
  },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const userId = String((user as { id?: string; _id?: string }).id ?? user._id);
    const match = await ctx.db.get(args.matchId);
    if (!match) {
      throw new ConvexError("Match not found");
    }
    const players = await listMatchPlayerDocs(ctx, match._id);
    if (!players.some((player) => player.userId === userId)) {
      throw new ConvexError("User is not in the match");
    }
    return await buildMatchView(ctx, match);
  },
});

export const listMatchEvents = query({
  args: {
    matchId: v.id("matches"),
  },
  handler: async (ctx, args) => {
    await authComponent.getAuthUser(ctx);
    const match = await ctx.db.get(args.matchId);
    if (!match) {
      throw new ConvexError("Match not found");
    }
    return (await buildMatchView(ctx, match)).events;
  },
});

export const createMatch = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const lobby = await getLobbyByCodeDoc(ctx, args.code);
    const members = await listLobbyMemberDocs(ctx, lobby._id);

    if (!members.some((member) => member.userId === user.authUserId)) {
      throw new ConvexError("User is not in the lobby");
    }

    if (members.length !== MAX_LOBBY_PLAYERS) {
      throw new ConvexError("Exactly six players are required to create a match");
    }

    if (lobby.status !== "probing") {
      throw new ConvexError("Lobby must complete probing before match creation");
    }

    let hostUserId = lobby.hostUserId;
    if (!hostUserId) {
      const probeResults = await ctx.db
        .query("probeResults")
        .withIndex("by_lobbyId", (query) => query.eq("lobbyId", lobby._id))
        .collect();

      const selection = selectHostCandidate({
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
      hostUserId = selection.hostUserId;
      await ctx.db.patch(lobby._id, { hostUserId });
    }

    const seed = `${lobby._id}:${Date.now()}`;
    const teamAssignments = assignTeams(
      members.map((member) => member.userId),
      seed,
    );
    const teamByUserId = new Map(
      teamAssignments.map((assignment) => [assignment.userId, assignment.team]),
    );

    await Promise.all(
      members.map(async (member) => {
        await ctx.db.patch(member._id, {
          team: teamByUserId.get(member.userId) ?? null,
          ready: false,
        });
      }),
    );

    const now = Date.now();
    const matchId = await ctx.db.insert("matches", {
      lobbyId: lobby._id,
      hostUserId,
      status: "live",
      startedAt: now,
      endedAt: null,
      scoreAlpha: 0,
      scoreBravo: 0,
      lastEventSeq: 2,
    });

    await Promise.all(
      members.map(async (member) => {
        const profile = await ctx.db
          .query("users")
          .withIndex("by_authUserId", (query) =>
            query.eq("authUserId", member.userId),
          )
          .unique();

        await ctx.db.insert("matchPlayers", {
          matchId,
          userId: member.userId,
          username: profile?.username ?? member.userId,
          displayName: profile?.displayName ?? member.userId,
          team: teamByUserId.get(member.userId) ?? "alpha",
        });
      }),
    );

    await ctx.db.insert("matchEvents", {
      matchId,
      seq: 1,
      type: "hostSelected",
      actorUserId: hostUserId,
      victimUserId: null,
      weaponId: null,
      headshot: false,
      occurredAtMs: now,
      metadata: { message: "Host selected for lobby" },
      serverTimestamp: now,
    });

    await ctx.db.insert("matchEvents", {
      matchId,
      seq: 2,
      type: "roundStart",
      actorUserId: null,
      victimUserId: null,
      weaponId: null,
      headshot: false,
      occurredAtMs: now,
      metadata: { message: "Match started" },
      serverTimestamp: now,
    });

    await ctx.db.patch(lobby._id, {
      status: "match_live",
      matchId,
      hostUserId,
      probeDeadlineAt: null,
    });

    const match = await ctx.db.get(matchId);
    if (!match) {
      throw new ConvexError("Match creation failed");
    }

    return await buildMatchView(ctx, match);
  },
});

export const appendMatchEvents = mutation({
  args: {
    matchId: v.id("matches"),
    events: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const match = await ctx.db.get(args.matchId);
    if (!match) {
      throw new ConvexError("Match not found");
    }
    if (match.status !== "live") {
      throw new ConvexError("Match is not live");
    }
    if (match.hostUserId !== user.authUserId) {
      throw new ConvexError("Only the selected host can append match events");
    }

    const parsed = appendMatchEventsInputSchema.safeParse({
      events: args.events,
    });
    if (!parsed.success) {
      throw new ConvexError(parsed.error.flatten().fieldErrors);
    }

    const players = await listMatchPlayerDocs(ctx, match._id);
    const teamByUserId = new Map(
      players.map((player) => [player.userId, player.team]),
    );

    let lastSeq = match.lastEventSeq;
    let scoreAlpha = match.scoreAlpha;
    let scoreBravo = match.scoreBravo;

    for (const event of parsed.data.events) {
      if (event.seq <= lastSeq) {
        throw new ConvexError("Match event sequence must be strictly increasing");
      }

      if (event.actorUserId && !teamByUserId.has(event.actorUserId)) {
        throw new ConvexError("Event actor is not in this match");
      }

      if (event.victimUserId && !teamByUserId.has(event.victimUserId)) {
        throw new ConvexError("Event victim is not in this match");
      }

      if (
        event.type === "kill" &&
        event.actorUserId &&
        event.victimUserId &&
        teamByUserId.get(event.actorUserId) === teamByUserId.get(event.victimUserId)
      ) {
        throw new ConvexError("Friendly-fire kill events are not allowed in TDM");
      }

      if (event.type === "kill" && event.actorUserId) {
        if (teamByUserId.get(event.actorUserId) === "alpha") {
          scoreAlpha += 1;
        } else {
          scoreBravo += 1;
        }
      }

      await ctx.db.insert("matchEvents", {
        matchId: match._id,
        seq: event.seq,
        type: event.type,
        actorUserId: event.actorUserId ?? null,
        victimUserId: event.victimUserId ?? null,
        weaponId: event.weaponId ?? null,
        headshot: event.headshot ?? false,
        occurredAtMs: event.occurredAtMs ?? null,
        metadata: event.metadata,
        serverTimestamp: Date.now(),
      });

      lastSeq = event.seq;
    }

    await ctx.db.patch(match._id, {
      lastEventSeq: lastSeq,
      scoreAlpha,
      scoreBravo,
    });

    const refreshedMatch = await ctx.db.get(match._id);
    if (!refreshedMatch) {
      throw new ConvexError("Match not found");
    }
    return await buildMatchView(ctx, refreshedMatch);
  },
});

export const abortMatch = mutation({
  args: {
    matchId: v.id("matches"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ensureCurrentUserProfile(ctx);
    const match = await ctx.db.get(args.matchId);
    if (!match) {
      throw new ConvexError("Match not found");
    }
    const lobby = await ctx.db.get(match.lobbyId);
    if (!lobby) {
      throw new ConvexError("Lobby not found");
    }
    const members = await listLobbyMemberDocs(ctx, lobby._id);
    if (!members.some((member) => member.userId === user.authUserId)) {
      throw new ConvexError("User is not part of the match lobby");
    }

    await abortLobbyMatch(
      ctx,
      lobby,
      args.reason ?? "Match aborted by a lobby member.",
    );

    const refreshedLobby = await ctx.db.get(lobby._id);
    if (!refreshedLobby) {
      throw new ConvexError("Lobby not found");
    }
    return await buildLobbyView(ctx, refreshedLobby);
  },
});
