import {
  appendMatchEventsInputSchema,
  createLobbyInputSchema,
  passwordSchema,
  readyInputSchema,
  reportProbeInputSchema,
  usernameSchema,
} from "@greytrace/contracts";
import type { NodeWebSocket } from "@hono/node-ws";
import { zValidator } from "@hono/zod-validator";
import { cors } from "hono/cors";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ConvexJwtVerifier } from "./auth";
import { extractBearerToken } from "./auth";
import type { AppConfig } from "./config";
import {
  createRateLimitMiddleware,
  InMemoryRateLimiter,
} from "./rate-limit";
import { registerSignalingRoute, type SignalingHub } from "./signaling";
import type { AuthSession, BackendService } from "./types";

type AppBindings = {
  Variables: {
    auth: AuthSession;
  };
};

const usernameSignupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayUsername: z.string().trim().min(1).max(64).optional(),
});

const cloneResponse = (response: Response) =>
  new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });

const proxyAuthRequest = async (
  request: Request,
  targetBaseUrl: string,
  fetchImpl: typeof fetch,
) => {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    targetBaseUrl,
  );

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const response = await fetchImpl(targetUrl, {
    method: request.method,
    headers,
    body,
  });

  return cloneResponse(response);
};

const unauthorized = () =>
  new HTTPException(401, {
    message: "Missing or invalid bearer token",
  });

const registerProtectedMiddleware = (
  app: Hono<AppBindings>,
  verifier: ConvexJwtVerifier,
) => {
  const authMiddleware: MiddlewareHandler<AppBindings> = async (
    context,
    next,
  ) => {
    const token = extractBearerToken(context.req.header("authorization"));
    if (!token) {
      throw unauthorized();
    }

    const claims = await verifier.verify(token);
    context.set("auth", { token, claims });
    await next();
  };

  app.use("/api/me", authMiddleware);
  app.use("/api/lobbies", authMiddleware);
  app.use("/api/lobbies/*", authMiddleware);
  app.use("/api/matches/*", authMiddleware);
};

export const createApp = (options: {
  config: AppConfig;
  backend: BackendService;
  verifier: ConvexJwtVerifier;
  fetchImpl?: typeof fetch;
  ws?: NodeWebSocket["upgradeWebSocket"];
  signalingHub?: SignalingHub;
  limiter?: InMemoryRateLimiter;
}) => {
  const app = new Hono<AppBindings>();
  const limiter = options.limiter ?? new InMemoryRateLimiter();
  const authRateLimit = createRateLimitMiddleware({
    limiter,
    limit: 20,
    windowMs: 60_000,
    namespace: "auth",
  });
  const lobbyRateLimit = createRateLimitMiddleware({
    limiter,
    limit: 24,
    windowMs: 60_000,
    namespace: "lobby",
  });
  const eventsRateLimit = createRateLimitMiddleware({
    limiter,
    limit: 120,
    windowMs: 60_000,
    namespace: "match-events",
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  app.use(
    "*",
    cors({
      origin: options.config.CORS_ORIGIN,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Better-Auth-Cookie",
      ],
      exposeHeaders: ["Set-Better-Auth-Cookie"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      credentials: true,
    }),
  );

  registerProtectedMiddleware(app, options.verifier);

  app.get("/api/health", (context) =>
    context.json({
      ok: true,
      service: "greytrace-api",
      region: "us-east-1",
      timestamp: Date.now(),
    }),
  );

  app.post(
    "/api/auth/sign-up/username",
    authRateLimit,
    zValidator("json", usernameSignupSchema),
    async (context) => {
      const body = context.req.valid("json");
      const syntheticEmail = `${body.username.toLowerCase()}@users.greytrace.local`;
      const displayName = body.displayUsername ?? body.username;

      const response = await fetchImpl(
        new URL("/api/auth/sign-up/email", options.config.CONVEX_SITE_URL),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: syntheticEmail,
            password: body.password,
            name: displayName,
            username: body.username,
            displayUsername: displayName,
          }),
        },
      );

      return cloneResponse(response);
    },
  );

  app.all("/api/auth/*", authRateLimit, async (context) => {
    return await proxyAuthRequest(
      context.req.raw,
      options.config.CONVEX_SITE_URL,
      fetchImpl,
    );
  });

  app.get("/api/me", async (context) => {
    const auth = context.get("auth");
    const user = await options.backend.ensureCurrentUser(auth.token);
    return context.json({
      user,
      turn: options.config.turn,
    });
  });

  app.post(
    "/api/lobbies",
    lobbyRateLimit,
    zValidator("json", createLobbyInputSchema),
    async (context) => {
      const auth = context.get("auth");
      const lobby = await options.backend.createLobby(
        auth.token,
        context.req.valid("json"),
      );
      return context.json(lobby);
    },
  );

  app.post("/api/lobbies/:code/join", lobbyRateLimit, async (context) => {
    const auth = context.get("auth");
    const lobby = await options.backend.joinLobby(auth.token, context.req.param("code"));
    return context.json(lobby);
  });

  app.post("/api/lobbies/:code/leave", lobbyRateLimit, async (context) => {
    const auth = context.get("auth");
    const lobby = await options.backend.leaveLobby(auth.token, context.req.param("code"));
    return context.json(lobby);
  });

  app.post(
    "/api/lobbies/:code/ready",
    lobbyRateLimit,
    zValidator("json", readyInputSchema),
    async (context) => {
      const auth = context.get("auth");
      const lobby = await options.backend.setReady(
        auth.token,
        context.req.param("code"),
        context.req.valid("json"),
      );
      return context.json(lobby);
    },
  );

  app.post("/api/lobbies/:code/start-probe", lobbyRateLimit, async (context) => {
    const auth = context.get("auth");
    const lobby = await options.backend.startProbe(auth.token, context.req.param("code"));
    return context.json({
      lobby,
      turn: options.config.turn,
    });
  });

  app.post(
    "/api/lobbies/:code/report-probe",
    lobbyRateLimit,
    zValidator("json", reportProbeInputSchema),
    async (context) => {
      const auth = context.get("auth");
      const lobby = await options.backend.reportProbe(
        auth.token,
        context.req.param("code"),
        context.req.valid("json"),
      );
      return context.json(lobby);
    },
  );

  app.post("/api/lobbies/:code/start-match", lobbyRateLimit, async (context) => {
    const auth = context.get("auth");
    const match = await options.backend.startMatch(auth.token, context.req.param("code"));
    return context.json({
      match,
      turn: options.config.turn,
    });
  });

  app.post(
    "/api/matches/:id/events",
    eventsRateLimit,
    zValidator("json", appendMatchEventsInputSchema),
    async (context) => {
      const auth = context.get("auth");
      const match = await options.backend.appendMatchEvents(
        auth.token,
        context.req.param("id"),
        context.req.valid("json"),
      );
      return context.json(match);
    },
  );

  if (options.ws) {
    registerSignalingRoute(app, {
      backend: options.backend,
      verifier: options.verifier,
      upgradeWebSocket: options.ws,
      limiter,
      hub: options.signalingHub,
    });
  }

  app.notFound((context) =>
    context.json(
      {
        error: "not_found",
      },
      404,
    ),
  );

  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json(
        {
          error: error.message,
        },
        error.status,
      );
    }

    return context.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown failure",
      },
      500,
    );
  });

  return app;
};
