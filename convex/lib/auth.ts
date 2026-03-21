import { ConvexError } from "convex/values";
import type { CurrentUser } from "../../packages/contracts/src";
import { authComponent } from "../auth";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ReaderCtx = QueryCtx | MutationCtx;
type BetterAuthUserLike = {
  _id?: string;
  id?: string;
  username?: string | null;
  displayUsername?: string | null;
  name?: string | null;
  email?: string | null;
  createdAt: number | Date;
  updatedAt?: number | Date | null;
};

const resolveAuthUserId = (authUser: BetterAuthUserLike) =>
  String(authUser.id ?? authUser._id);

const deriveDisplayName = (authUser: {
  displayUsername?: string | null;
  name?: string | null;
  username?: string | null;
  email?: string | null;
}) =>
  authUser.displayUsername ??
  authUser.name ??
  authUser.username ??
  authUser.email?.split("@")[0] ??
  "operator";

const deriveUsername = (authUser: {
  username?: string | null;
  email?: string | null;
  name?: string | null;
}) =>
  authUser.username ??
  authUser.email?.split("@")[0] ??
  authUser.name?.replace(/\s+/g, "_").toLowerCase() ??
  "operator";

export const mapProfileDocToView = (doc: Doc<"users">): CurrentUser => ({
  id: doc.authUserId,
  authUserId: doc.authUserId,
  username: doc.username,
  displayName: doc.displayName,
  createdAt: doc.createdAt,
  lastSeenAt: doc.lastSeenAt,
});

export const mapAuthUserToView = (authUser: BetterAuthUserLike): CurrentUser => ({
  id: resolveAuthUserId(authUser),
  authUserId: resolveAuthUserId(authUser),
  username: deriveUsername(authUser),
  displayName: deriveDisplayName(authUser),
  createdAt: Number(authUser.createdAt),
  lastSeenAt: Number(authUser.updatedAt ?? authUser.createdAt),
});

export const getStoredProfileByAuthUserId = async (
  ctx: ReaderCtx,
  authUserId: string,
) =>
  await ctx.db
    .query("users")
    .withIndex("by_authUserId", (query) => query.eq("authUserId", authUserId))
    .unique();

export const getProfileViewByAuthUserId = async (
  ctx: ReaderCtx,
  authUserId: string,
) => {
  const stored = await getStoredProfileByAuthUserId(ctx, authUserId);
  if (stored) {
    return mapProfileDocToView(stored);
  }

  const authUser = await authComponent.getAnyUserById(ctx, authUserId);
  if (!authUser) {
    throw new ConvexError("Unknown lobby member");
  }

  return mapAuthUserToView({
    id: String((authUser as { id?: string; _id?: string }).id ?? authUser._id),
    username: authUser.username,
    displayUsername: authUser.displayUsername,
    name: authUser.name,
    email: authUser.email,
    createdAt: authUser.createdAt,
    updatedAt: authUser.updatedAt,
  });
};

export const ensureCurrentUserProfile = async (ctx: MutationCtx) => {
  const authUser = await authComponent.getAuthUser(ctx);
  const authUserId = resolveAuthUserId(authUser);
  const now = Date.now();
  const existing = await getStoredProfileByAuthUserId(ctx, authUserId);
  const patch = {
    username: deriveUsername(authUser),
    displayName: deriveDisplayName(authUser),
    lastSeenAt: now,
  };

  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return {
      ...mapProfileDocToView(existing),
      ...patch,
      id: existing.authUserId,
      authUserId: existing.authUserId,
      createdAt: existing.createdAt,
    } satisfies CurrentUser;
  }

  await ctx.db.insert("users", {
    authUserId,
    username: patch.username,
    displayName: patch.displayName,
    createdAt: Number(authUser.createdAt),
    lastSeenAt: now,
  });

  return {
    id: authUserId,
    authUserId,
    username: patch.username,
    displayName: patch.displayName,
    createdAt: Number(authUser.createdAt),
    lastSeenAt: now,
  } satisfies CurrentUser;
};

export const getCurrentUserView = async (ctx: ReaderCtx) => {
  const authUser = await authComponent.getAuthUser(ctx);
  const existing = await getStoredProfileByAuthUserId(
    ctx,
    resolveAuthUserId(authUser),
  );
  return existing ? mapProfileDocToView(existing) : mapAuthUserToView(authUser);
};
