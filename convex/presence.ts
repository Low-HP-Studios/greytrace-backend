import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { HttpError } from "./lib/httpError";
import { normalizeLobbyCode } from "./lib/validation";
import { requireAuthMutation } from "./sessionHelpers";

export const heartbeat = mutation({
  args: {
    sessionToken: v.string(),
    lobbyCode: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    const nowIso = new Date().toISOString();
    const code = normalizeLobbyCode(args.lobbyCode);

    const lobby = await ctx.db
      .query("lobbies")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (!lobby || lobby.expiresAt <= nowIso) {
      throw new HttpError(404, "Lobby not found.");
    }

    const member = await ctx.db
      .query("lobbyMembers")
      .withIndex("by_lobby_id_and_user_id", (q) =>
        q.eq("lobbyId", lobby._id).eq("userId", auth.userId),
      )
      .unique();

    if (!member) {
      throw new HttpError(403, "You are not a member of that lobby.");
    }

    const nowMs = Date.now();
    const existing = await ctx.db
      .query("lobbyPresence")
      .withIndex("by_lobby_code_and_user_id", (q) =>
        q.eq("lobbyCode", code).eq("userId", auth.userId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: nowMs });
    } else {
      await ctx.db.insert("lobbyPresence", {
        lobbyCode: code,
        userId: auth.userId,
        lastSeenAt: nowMs,
      });
    }

    return { ok: true as const };
  },
});
