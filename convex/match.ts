// DEPRECATED: greytrace-backend is retired; do not use.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { createMatchRuntimeManager } from "./matchRuntimeEngine";
import type { MatchRuntimeOutcome } from "./matchRuntimeEngine";
import type {
  MatchRealtimeViewPayload,
  MatchStatePayload,
  ShotFiredPayload,
} from "./domain";
import { HttpError } from "./lib/httpError";
import { normalizeLobbyCode } from "./lib/validation";
import { requireAuthMutation, requireAuthQuery } from "./sessionHelpers";

const incomingPlayerStateValidator = v.object({
  slotIndex: v.number(),
  seq: v.number(),
  x: v.number(),
  y: v.number(),
  z: v.number(),
  yaw: v.number(),
  bodyYaw: v.number(),
  pitch: v.number(),
  moving: v.boolean(),
  sprinting: v.boolean(),
  crouched: v.boolean(),
  grounded: v.boolean(),
  ads: v.boolean(),
  animState: v.string(),
  locomotionScale: v.number(),
  lowerBodyState: v.union(v.string(), v.null()),
  lowerBodyLocomotionScale: v.number(),
  upperBodyState: v.union(v.string(), v.null()),
});

async function requireLobbyMemberInMatch(
  ctx: QueryCtx | MutationCtx,
  authUserId: Id<"users">,
  lobbyCode: string,
  nowIso: string,
) {
  const lobby = await ctx.db
    .query("lobbies")
    .withIndex("by_code", (q) => q.eq("code", lobbyCode))
    .unique();

  if (!lobby || lobby.expiresAt <= nowIso) {
    throw new HttpError(404, "Lobby not found.");
  }

  if (lobby.status !== "in_match") {
    throw new HttpError(409, "Lobby is not in a match.");
  }

  const member = await ctx.db
    .query("lobbyMembers")
    .withIndex("by_lobby_id_and_user_id", (q) =>
      q.eq("lobbyId", lobby._id).eq("userId", authUserId),
    )
    .unique();

  if (!member) {
    throw new HttpError(403, "You are not a member of that lobby.");
  }

  return lobby;
}

async function loadManagerForLobby(ctx: MutationCtx, lobbyCode: string) {
  const row = await ctx.db
    .query("matchRuntimes")
    .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", lobbyCode))
    .unique();

  if (!row) {
    return null;
  }

  const mgr = createMatchRuntimeManager();
  mgr.loadSerialized(row.stateJson);
  return { mgr, rowId: row._id };
}

function parseLatestShotJson(raw: string | null): ShotFiredPayload | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ShotFiredPayload;
  } catch {
    return null;
  }
}

export const getMatchState = query({
  args: {
    sessionToken: v.string(),
    lobbyCode: v.string(),
  },
  handler: async (ctx, args): Promise<MatchStatePayload | null> => {
    const auth = await requireAuthQuery(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const code = normalizeLobbyCode(args.lobbyCode);

    await requireLobbyMemberInMatch(ctx, auth.userId, code, nowIso);

    const row = await ctx.db
      .query("matchRuntimes")
      .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", code))
      .unique();

    if (!row) {
      return null;
    }

    const mgr = createMatchRuntimeManager();
    mgr.loadSerialized(row.stateJson);
    return mgr.getMatchState(code);
  },
});

export const getRealtimeView = query({
  args: {
    sessionToken: v.string(),
    lobbyCode: v.string(),
  },
  handler: async (ctx, args): Promise<MatchRealtimeViewPayload | null> => {
    const auth = await requireAuthQuery(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const code = normalizeLobbyCode(args.lobbyCode);

    const lobby = await ctx.db
      .query("lobbies")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (!lobby || lobby.expiresAt <= nowIso || lobby.status !== "in_match") {
      return null;
    }

    const member = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id_and_user_id", (q) =>
        q.eq("lobbyId", lobby._id).eq("userId", auth.userId),
      )
      .unique();

    if (!member) {
      return null;
    }

    const row = await ctx.db
      .query("matchRuntimes")
      .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", code))
      .unique();

    if (!row) {
      return null;
    }

    const mgr = createMatchRuntimeManager();
    mgr.loadSerialized(row.stateJson);

    return {
      matchState: mgr.getMatchState(code),
      playerStates: mgr.getPlayerStates(code),
      latestShotEvent: parseLatestShotJson(row.latestShotJson),
    };
  },
});

export const submitPlayerState = mutation({
  args: {
    sessionToken: v.string(),
    lobbyCode: v.string(),
    state: incomingPlayerStateValidator,
  },
  handler: async (ctx, args): Promise<MatchRuntimeOutcome> => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const code = normalizeLobbyCode(args.lobbyCode);

    await requireLobbyMemberInMatch(ctx, auth.userId, code, nowIso);

    const loaded = await loadManagerForLobby(ctx, code);
    if (!loaded) {
      throw new HttpError(409, "Match runtime is unavailable for that lobby.");
    }

    const { mgr, rowId } = loaded;
    const outcome = mgr.handlePlayerState(
      code,
      auth.userId,
      args.state,
      new Date(),
    );

    const serialized = mgr.serializeCurrent(code);
    if (serialized) {
      await ctx.db.patch(rowId, { stateJson: serialized });
    }

    return outcome;
  },
});

export const submitFire = mutation({
  args: {
    sessionToken: v.string(),
    lobbyCode: v.string(),
    shotId: v.string(),
    weaponType: v.literal("rifle"),
  },
  handler: async (ctx, args): Promise<MatchRuntimeOutcome> => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const code = normalizeLobbyCode(args.lobbyCode);

    await requireLobbyMemberInMatch(ctx, auth.userId, code, nowIso);

    const loaded = await loadManagerForLobby(ctx, code);
    if (!loaded) {
      throw new HttpError(409, "Match runtime is unavailable for that lobby.");
    }

    const { mgr, rowId } = loaded;
    const outcome = mgr.handleFire(
      code,
      auth.userId,
      args.shotId,
      args.weaponType,
      new Date(),
    );

    const serialized = mgr.serializeCurrent(code);
    if (serialized || outcome.shotFired) {
      await ctx.db.patch(rowId, {
        ...(serialized ? { stateJson: serialized } : {}),
        ...(outcome.shotFired
          ? { latestShotJson: JSON.stringify(outcome.shotFired) }
          : {}),
      });
    }

    return outcome;
  },
});

export const submitReload = mutation({
  args: {
    sessionToken: v.string(),
    lobbyCode: v.string(),
  },
  handler: async (ctx, args): Promise<MatchRuntimeOutcome> => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const code = normalizeLobbyCode(args.lobbyCode);

    await requireLobbyMemberInMatch(ctx, auth.userId, code, nowIso);

    const loaded = await loadManagerForLobby(ctx, code);
    if (!loaded) {
      throw new HttpError(409, "Match runtime is unavailable for that lobby.");
    }

    const { mgr, rowId } = loaded;
    const outcome = mgr.handleReload(code, auth.userId, new Date());

    const serialized = mgr.serializeCurrent(code);
    if (serialized) {
      await ctx.db.patch(rowId, { stateJson: serialized });
    }

    return outcome;
  },
});
