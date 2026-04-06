import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import bcrypt from "bcryptjs";
import { HttpError } from "./lib/httpError";
import { createOpaqueToken, hashTokenHex } from "./lib/crypto";
import { normalizeUsername, validateCredentials } from "./lib/validation";
import { SESSION_TTL_MS } from "./constants";
import { requireAuthMutation, requireAuthQuery } from "./sessionHelpers";
import { internal } from "./_generated/api";

export const signUp = mutation({
  args: {
    username: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const trimmedUsername = args.username.trim();
    const usernameNormalized = normalizeUsername(trimmedUsername);
    validateCredentials(trimmedUsername, args.password);

    const existing = await ctx.db
      .query("users")
      .withIndex("by_username_normalized", (q) =>
        q.eq("usernameNormalized", usernameNormalized),
      )
      .unique();

    if (existing) {
      throw new HttpError(409, "That username is already taken.");
    }

    // Convex mutations can't use timer-based async helpers, so bcryptjs must stay sync here.
    const passwordHash = bcrypt.hashSync(args.password, 12);
    const nowIso = new Date().toISOString();
    const userId = await ctx.db.insert("users", {
      username: trimmedUsername,
      usernameNormalized,
      passwordHash,
      createdAt: nowIso,
    });

    const rawToken = createOpaqueToken();
    const tokenHash = await hashTokenHex(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await ctx.db.insert("sessions", {
      userId,
      tokenHash,
      createdAt: nowIso,
      expiresAt,
      lastUsedAt: nowIso,
    });

    return {
      token: rawToken,
      user: {
        id: userId,
        username: trimmedUsername,
        createdAt: nowIso,
      },
    };
  },
});

export const signIn = mutation({
  args: {
    username: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const trimmedUsername = args.username.trim();
    const usernameNormalized = normalizeUsername(trimmedUsername);
    validateCredentials(trimmedUsername, args.password);

    const user = await ctx.db
      .query("users")
      .withIndex("by_username_normalized", (q) =>
        q.eq("usernameNormalized", usernameNormalized),
      )
      .unique();

    if (!user) {
      throw new HttpError(401, "Invalid username or password.");
    }

    const passwordMatches = bcrypt.compareSync(args.password, user.passwordHash);
    if (!passwordMatches) {
      throw new HttpError(401, "Invalid username or password.");
    }

    const rawToken = createOpaqueToken();
    const tokenHash = await hashTokenHex(rawToken);
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await ctx.db.insert("sessions", {
      userId: user._id,
      tokenHash,
      createdAt: nowIso,
      expiresAt,
      lastUsedAt: nowIso,
    });

    return {
      token: rawToken,
      user: {
        id: user._id,
        username: user.username,
        createdAt: user.createdAt,
      },
    };
  },
});

export const getSession = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    try {
      const auth = await requireAuthQuery(ctx, args.sessionToken);
      return {
        user: {
          id: auth.userId,
          username: auth.username,
          createdAt: auth.createdAt,
        },
      };
    } catch {
      return null;
    }
  },
});

export const logout = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const auth = await requireAuthMutation(ctx, args.sessionToken);
    await ctx.runMutation(internal.lobbies.leaveCurrentInternal, {
      userId: auth.userId,
    });
    const session = await ctx.db.get(auth.sessionId);
    if (session && session.tokenHash === auth.tokenHash) {
      await ctx.db.delete(auth.sessionId);
    }
    return { ok: true };
  },
});
