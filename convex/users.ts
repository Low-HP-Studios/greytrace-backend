import { mutation, query } from "./_generated/server";
import {
  ensureCurrentUserProfile as ensureCurrentUserProfileHelper,
  getCurrentUserView,
} from "./lib/auth";

export const ensureCurrentUserProfile = mutation({
  args: {},
  handler: async (ctx) => await ensureCurrentUserProfileHelper(ctx),
});

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => await getCurrentUserView(ctx),
});
