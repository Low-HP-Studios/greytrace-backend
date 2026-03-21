import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const nullableString = v.union(v.null(), v.string());
const nullableNumber = v.union(v.null(), v.number());
const nullableMatchId = v.union(v.null(), v.id("matches"));
const nullableTeam = v.union(v.null(), v.union(v.literal("alpha"), v.literal("bravo")));

export default defineSchema({
  users: defineTable({
    authUserId: v.string(),
    username: v.string(),
    displayName: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_username", ["username"]),

  lobbies: defineTable({
    code: v.string(),
    status: v.union(
      v.literal("forming"),
      v.literal("probing"),
      v.literal("match_live"),
      v.literal("closed"),
    ),
    mode: v.literal("tdm"),
    mapId: v.string(),
    maxPlayers: v.number(),
    ownerUserId: v.string(),
    hostUserId: nullableString,
    matchId: nullableMatchId,
    probeDeadlineAt: nullableNumber,
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  lobbyMembers: defineTable({
    lobbyId: v.id("lobbies"),
    userId: v.string(),
    slot: v.number(),
    ready: v.boolean(),
    team: nullableTeam,
    joinedAt: v.number(),
    connectionState: v.union(v.literal("connected"), v.literal("disconnected")),
  })
    .index("by_lobbyId", ["lobbyId"])
    .index("by_lobbyId_userId", ["lobbyId", "userId"])
    .index("by_userId", ["userId"]),

  probeResults: defineTable({
    lobbyId: v.id("lobbies"),
    sourceUserId: v.string(),
    targetUserId: v.string(),
    medianRttMs: v.number(),
    maxRttMs: v.number(),
    jitterMs: v.number(),
    lossPct: v.number(),
    sampledAt: v.number(),
  })
    .index("by_lobbyId", ["lobbyId"])
    .index("by_lobbyId_sourceUserId", ["lobbyId", "sourceUserId"])
    .index("by_lobbyId_source_target", ["lobbyId", "sourceUserId", "targetUserId"]),

  matches: defineTable({
    lobbyId: v.id("lobbies"),
    hostUserId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("live"),
      v.literal("aborted"),
      v.literal("completed"),
    ),
    startedAt: v.number(),
    endedAt: nullableNumber,
    scoreAlpha: v.number(),
    scoreBravo: v.number(),
    lastEventSeq: v.number(),
  }).index("by_lobbyId", ["lobbyId"]),

  matchPlayers: defineTable({
    matchId: v.id("matches"),
    userId: v.string(),
    username: v.string(),
    displayName: v.string(),
    team: v.union(v.literal("alpha"), v.literal("bravo")),
  })
    .index("by_matchId", ["matchId"])
    .index("by_matchId_userId", ["matchId", "userId"]),

  matchEvents: defineTable({
    matchId: v.id("matches"),
    seq: v.number(),
    type: v.string(),
    actorUserId: nullableString,
    victimUserId: nullableString,
    weaponId: nullableString,
    headshot: v.boolean(),
    occurredAtMs: nullableNumber,
    metadata: v.optional(v.any()),
    serverTimestamp: v.number(),
  })
    .index("by_matchId", ["matchId"])
    .index("by_matchId_seq", ["matchId", "seq"]),
});
