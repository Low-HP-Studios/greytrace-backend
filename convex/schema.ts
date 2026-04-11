// DEPRECATED: greytrace-backend is retired; do not use.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(),
    usernameNormalized: v.string(),
    passwordHash: v.string(),
    createdAt: v.string(),
  }).index("by_username_normalized", ["usernameNormalized"]),

  sessions: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    createdAt: v.string(),
    expiresAt: v.string(),
    lastUsedAt: v.string(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_user_id", ["userId"])
    .index("by_expires_at", ["expiresAt"]),

  lobbies: defineTable({
    code: v.string(),
    hostUserId: v.id("users"),
    status: v.union(v.literal("open"), v.literal("in_match")),
    maxPlayers: v.number(),
    selectedMapId: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
    expiresAt: v.string(),
    matchStartedAt: v.union(v.string(), v.null()),
    hostAddress: v.union(v.string(), v.null()),
    hostPort: v.union(v.number(), v.null()),
    protocolVersion: v.union(v.number(), v.null()),
    lastMatchEndedReason: v.union(
      v.literal("host_disconnected"),
      v.literal("player_disconnected"),
      v.literal("host_left"),
      v.literal("player_left"),
      v.literal("host_ended_match"),
      v.literal("player_ended_match"),
      v.null(),
    ),
  })
    .index("by_code", ["code"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_host_user_id", ["hostUserId"]),

  lobbyMembers: defineTable({
    lobbyId: v.id("lobbies"),
    userId: v.id("users"),
    isReady: v.boolean(),
    selectedCharacterId: v.string(),
    joinedAt: v.string(),
  })
    .index("by_lobby_id", ["lobbyId"])
    .index("by_user_id", ["userId"])
    .index("by_lobby_id_and_user_id", ["lobbyId", "userId"]),

  lobbyPresence: defineTable({
    lobbyCode: v.string(),
    userId: v.id("users"),
    lastSeenAt: v.number(),
  })
    .index("by_lobby_code", ["lobbyCode"])
    .index("by_lobby_code_and_user_id", ["lobbyCode", "userId"])
    .index("by_user_id", ["userId"]),

  matchRuntimes: defineTable({
    lobbyCode: v.string(),
    stateJson: v.string(),
    latestShotJson: v.union(v.string(), v.null()),
  }).index("by_lobby_code", ["lobbyCode"]),
});
