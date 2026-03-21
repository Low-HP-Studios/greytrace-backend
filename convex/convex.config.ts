import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";

const app: ReturnType<typeof defineApp> = defineApp();

app.use(betterAuth, { name: "betterAuth" });

export default app;
