// DEPRECATED: greytrace-backend is retired; do not use.

import { internalMutation } from "./_generated/server";

export const runCleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const nowIso = new Date().toISOString();

    const expiredSessions = await ctx.db
      .query("sessions")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", nowIso))
      .take(200);

    for (const session of expiredSessions) {
      await ctx.db.delete(session._id);
    }

    const expiredLobbies = await ctx.db
      .query("lobbies")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", nowIso))
      .take(50);

    for (const lobby of expiredLobbies) {
      const members = await ctx.db
        .query("lobbyMembers")
        .withIndex("by_lobby_id", (q) => q.eq("lobbyId", lobby._id))
        .collect();

      for (const member of members) {
        await ctx.db.delete(member._id);
      }

      const presenceRows = await ctx.db
        .query("lobbyPresence")
        .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", lobby.code))
        .collect();

      for (const row of presenceRows) {
        await ctx.db.delete(row._id);
      }

      const runtime = await ctx.db
        .query("matchRuntimes")
        .withIndex("by_lobby_code", (q) => q.eq("lobbyCode", lobby.code))
        .unique();

      if (runtime) {
        await ctx.db.delete(runtime._id);
      }

      await ctx.db.delete(lobby._id);
    }

    return null;
  },
});
