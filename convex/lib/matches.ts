import type { MatchEvent, MatchView } from "../../packages/contracts/src";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { listLobbyMemberDocs } from "./lobbies";

type ReaderCtx = QueryCtx | MutationCtx;

export const listMatchPlayerDocs = async (
  ctx: ReaderCtx,
  matchId: Doc<"matches">["_id"],
) =>
  await ctx.db
    .query("matchPlayers")
    .withIndex("by_matchId", (query) => query.eq("matchId", matchId))
    .collect();

export const listMatchEventDocs = async (
  ctx: ReaderCtx,
  matchId: Doc<"matches">["_id"],
) => {
  const docs = await ctx.db
    .query("matchEvents")
    .withIndex("by_matchId_seq", (query) => query.eq("matchId", matchId))
    .collect();

  return docs.sort((left, right) => left.seq - right.seq);
};

const mapMatchEventDoc = (event: Doc<"matchEvents">): MatchEvent & {
  serverTimestamp: number;
} => ({
  seq: event.seq,
  type: event.type as MatchEvent["type"],
  actorUserId: event.actorUserId ?? undefined,
  victimUserId: event.victimUserId ?? undefined,
  weaponId: event.weaponId ?? undefined,
  headshot: event.headshot || undefined,
  occurredAtMs: event.occurredAtMs ?? undefined,
  metadata:
    event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      ? (event.metadata as Record<string, unknown>)
      : undefined,
  serverTimestamp: event.serverTimestamp,
});

export const buildMatchView = async (
  ctx: ReaderCtx,
  match: Doc<"matches">,
): Promise<MatchView> => {
  const [players, events] = await Promise.all([
    listMatchPlayerDocs(ctx, match._id),
    listMatchEventDocs(ctx, match._id),
  ]);

  return {
    id: match._id,
    lobbyId: match.lobbyId,
    hostUserId: match.hostUserId,
    status: match.status,
    scoreAlpha: match.scoreAlpha,
    scoreBravo: match.scoreBravo,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    lastEventSeq: match.lastEventSeq,
    players: players.map((player) => ({
      userId: player.userId,
      username: player.username,
      displayName: player.displayName,
      team: player.team,
    })),
    events: events.map(mapMatchEventDoc),
  };
};

export const abortLobbyMatch = async (
  ctx: MutationCtx,
  lobby: Doc<"lobbies">,
  reason: string,
) => {
  if (!lobby.matchId) {
    return null;
  }

  const match = await ctx.db.get(lobby.matchId);
  if (!match || match.status !== "live") {
    return match;
  }

  const now = Date.now();
  const nextSeq = match.lastEventSeq + 1;

  await ctx.db.insert("matchEvents", {
    matchId: match._id,
    seq: nextSeq,
    type: "system",
    actorUserId: null,
    victimUserId: null,
    weaponId: null,
    headshot: false,
    occurredAtMs: null,
    metadata: { message: reason },
    serverTimestamp: now,
  });

  await ctx.db.patch(match._id, {
    status: "aborted",
    endedAt: now,
    lastEventSeq: nextSeq,
  });

  await ctx.db.patch(lobby._id, {
    status: "forming",
    hostUserId: null,
    matchId: null,
    probeDeadlineAt: null,
  });

  const members = await listLobbyMemberDocs(ctx, lobby._id);
  await Promise.all(
    members.map(async (member) => {
      await ctx.db.patch(member._id, {
        ready: false,
        team: null,
      });
    }),
  );

  return match;
};
