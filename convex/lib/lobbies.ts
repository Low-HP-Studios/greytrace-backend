import {
  MAX_LOBBY_PLAYERS,
  expectedProbeReportCount,
  normalizeLobbyCode,
} from "../../packages/contracts/src";
import type { LobbyMember, LobbyView } from "../../packages/contracts/src";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { getProfileViewByAuthUserId } from "./auth";

type ReaderCtx = QueryCtx | MutationCtx;

export const getLobbyByCodeDoc = async (ctx: ReaderCtx, code: string) => {
  const normalizedCode = normalizeLobbyCode(code);
  const lobby = await ctx.db
    .query("lobbies")
    .withIndex("by_code", (query) => query.eq("code", normalizedCode))
    .unique();

  if (!lobby) {
    throw new ConvexError("Lobby not found");
  }

  return lobby;
};

export const listLobbyMemberDocs = async (
  ctx: ReaderCtx,
  lobbyId: Id<"lobbies">,
) => {
  const members = await ctx.db
    .query("lobbyMembers")
    .withIndex("by_lobbyId", (query) => query.eq("lobbyId", lobbyId))
    .collect();

  return members.sort((left, right) => left.slot - right.slot);
};

export const buildLobbyMembers = async (
  ctx: ReaderCtx,
  members: Doc<"lobbyMembers">[],
) => {
  const views = await Promise.all(
    members.map(async (member): Promise<LobbyMember> => {
      const profile = await getProfileViewByAuthUserId(ctx, member.userId);
      return {
        userId: member.userId,
        username: profile.username,
        displayName: profile.displayName,
        slot: member.slot,
        ready: member.ready,
        team: member.team,
        joinedAt: member.joinedAt,
        connectionState: member.connectionState,
      };
    }),
  );

  return views.sort((left, right) => left.slot - right.slot);
};

export const buildLobbyView = async (
  ctx: ReaderCtx,
  lobby: Doc<"lobbies">,
): Promise<LobbyView> => {
  const members = await listLobbyMemberDocs(ctx, lobby._id);
  const memberViews = await buildLobbyMembers(ctx, members);
  const receivedReports = (
    await ctx.db
      .query("probeResults")
      .withIndex("by_lobbyId", (query) => query.eq("lobbyId", lobby._id))
      .collect()
  ).length;

  return {
    id: lobby._id,
    code: lobby.code,
    status: lobby.status,
    mode: "tdm",
    mapId: lobby.mapId,
    maxPlayers: MAX_LOBBY_PLAYERS,
    ownerUserId: lobby.ownerUserId,
    hostUserId: lobby.hostUserId,
    matchId: lobby.matchId,
    createdAt: lobby.createdAt,
    members: memberViews,
    probeSummary: {
      expectedReports: expectedProbeReportCount(memberViews.length),
      receivedReports,
      deadlineAt: lobby.probeDeadlineAt,
    },
  };
};

export const getMemberByUserId = (
  members: Doc<"lobbyMembers">[],
  userId: string,
) => members.find((member) => member.userId === userId) ?? null;

export const nextOpenSlot = (members: Doc<"lobbyMembers">[]) => {
  const occupiedSlots = new Set(members.map((member) => member.slot));
  for (let slot = 0; slot < MAX_LOBBY_PLAYERS; slot += 1) {
    if (!occupiedSlots.has(slot)) {
      return slot;
    }
  }
  throw new ConvexError("Lobby is full");
};

export const generateLobbyCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return code;
};

export const reserveUniqueLobbyCode = async (ctx: MutationCtx) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateLobbyCode();
    const existing = await ctx.db
      .query("lobbies")
      .withIndex("by_code", (query) => query.eq("code", code))
      .unique();
    if (!existing) {
      return code;
    }
  }

  throw new ConvexError("Unable to allocate a lobby code");
};

export const resetMemberState = async (
  ctx: MutationCtx,
  members: Doc<"lobbyMembers">[],
  options: {
    ready: boolean;
    clearTeams: boolean;
  },
) => {
  await Promise.all(
    members.map(async (member) => {
      await ctx.db.patch(member._id, {
        ready: options.ready,
        ...(options.clearTeams ? { team: null } : {}),
      });
    }),
  );
};
