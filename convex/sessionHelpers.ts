// DEPRECATED: greytrace-backend is retired; do not use.

import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { HttpError } from "./lib/httpError";
import { hashTokenHex } from "./lib/crypto";
import { SESSION_TTL_MS } from "./constants";

export type AuthSession = {
  sessionId: Id<"sessions">;
  tokenHash: string;
  userId: Id<"users">;
  username: string;
  createdAt: string;
};

export async function requireAuthMutation(
  ctx: MutationCtx,
  rawToken: string,
): Promise<AuthSession> {
  const trimmedToken = rawToken.trim();
  if (!trimmedToken) {
    throw new HttpError(401, "Authentication is required.");
  }

  const tokenHash = await hashTokenHex(trimmedToken);
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();

  if (!session) {
    throw new HttpError(401, "Authentication is required.");
  }

  const now = new Date();
  const nowIso = now.toISOString();
  if (session.expiresAt <= nowIso) {
    await ctx.db.delete(session._id);
    throw new HttpError(401, "Session expired. Please sign in again.");
  }

  const nextExpiryIso = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await ctx.db.patch(session._id, {
    expiresAt: nextExpiryIso,
    lastUsedAt: nowIso,
  });

  const user = await ctx.db.get(session.userId);
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }

  return {
    sessionId: session._id,
    tokenHash: session.tokenHash,
    userId: user._id,
    username: user.username,
    createdAt: user.createdAt,
  };
}

export async function requireAuthQuery(
  ctx: QueryCtx,
  rawToken: string,
): Promise<AuthSession> {
  const trimmedToken = rawToken.trim();
  if (!trimmedToken) {
    throw new HttpError(401, "Authentication is required.");
  }

  const tokenHash = await hashTokenHex(trimmedToken);
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();

  if (!session) {
    throw new HttpError(401, "Authentication is required.");
  }

  const nowIso = new Date().toISOString();
  if (session.expiresAt <= nowIso) {
    throw new HttpError(401, "Session expired. Please sign in again.");
  }

  const user = await ctx.db.get(session.userId);
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }

  return {
    sessionId: session._id,
    tokenHash: session.tokenHash,
    userId: user._id,
    username: user.username,
    createdAt: user.createdAt,
  };
}
