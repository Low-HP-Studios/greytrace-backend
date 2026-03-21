import { createClient } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { username } from "better-auth/plugins/username";
import type { BetterAuthOptions } from "better-auth/types";
import authConfig from "./auth.config";
import { components } from "./_generated/api";

export const authComponent = createClient(
  components.betterAuth as unknown as Parameters<typeof createClient>[0],
);

const trustedOrigins = [
  process.env.BETTER_AUTH_URL,
  process.env.CORS_ORIGIN,
  process.env.CONVEX_SITE_URL,
].filter((origin): origin is string => Boolean(origin));

export const createAuth = (ctx: Parameters<typeof authComponent.adapter>[0]) =>
  betterAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.CONVEX_SITE_URL,
    basePath: "/api/auth",
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
    },
    database: authComponent.adapter(ctx),
    plugins: [
      username(),
      bearer(),
      convex({
        authConfig,
      }),
    ],
  } satisfies BetterAuthOptions);
