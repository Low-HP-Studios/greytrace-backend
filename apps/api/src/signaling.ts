import { signalingMessageSchema, type LobbyView } from "@greytrace/contracts";
import type { NodeWebSocket } from "@hono/node-ws";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { ConvexJwtVerifier } from "./auth";
import { createRateLimitMiddleware, type InMemoryRateLimiter } from "./rate-limit";
import type { AuthSession, BackendService } from "./types";

type SignalingSession = {
  userId: string;
  lobbyCode: string;
  token: string;
  socket: WSContext;
};

export class SignalingHub {
  private readonly sessions = new Map<string, SignalingSession>();

  private key(lobbyCode: string, userId: string) {
    return `${lobbyCode}:${userId}`;
  }

  register(session: SignalingSession) {
    const key = this.key(session.lobbyCode, session.userId);
    const existing = this.sessions.get(key);
    if (existing && existing.socket.readyState === 1) {
      existing.socket.close(4000, "Superseded by a new connection");
    }
    this.sessions.set(key, session);
  }

  unregister(session: SignalingSession) {
    const key = this.key(session.lobbyCode, session.userId);
    const existing = this.sessions.get(key);
    if (existing?.socket === session.socket) {
      this.sessions.delete(key);
    }
  }

  sendTo(lobbyCode: string, userId: string, message: unknown) {
    const session = this.sessions.get(this.key(lobbyCode, userId));
    if (!session || session.socket.readyState !== 1) {
      return false;
    }
    session.socket.send(JSON.stringify(message));
    return true;
  }

  broadcastPeerLeft(lobbyCode: string, userId: string) {
    for (const session of this.sessions.values()) {
      if (session.lobbyCode !== lobbyCode || session.userId === userId) {
        continue;
      }
      if (session.socket.readyState !== 1) {
        continue;
      }
      session.socket.send(
        JSON.stringify({
          type: "peer-left",
          lobbyCode,
          userId,
        }),
      );
    }
  }
}

const ensureLobbyMembership = (lobby: LobbyView, userId: string) => {
  if (!lobby.members.some((member) => member.userId === userId)) {
    throw new HTTPException(403, {
      message: "User is not a member of the requested lobby",
    });
  }
};

export const registerSignalingRoute = (
  app: Hono<{
    Variables: {
      auth: AuthSession;
    };
  }>,
  options: {
    backend: BackendService;
    verifier: ConvexJwtVerifier;
    upgradeWebSocket: NodeWebSocket["upgradeWebSocket"];
    limiter: InMemoryRateLimiter;
    hub?: SignalingHub;
  },
) => {
  const hub = options.hub ?? new SignalingHub();
  const signalingRateLimit = createRateLimitMiddleware({
    limiter: options.limiter,
    limit: 60,
    windowMs: 60_000,
    namespace: "signaling",
  });

  app.get(
    "/ws/signaling",
    signalingRateLimit,
    options.upgradeWebSocket(
      async (context) => {
        const token = context.req.query("token");
        if (!token) {
          throw new HTTPException(401, { message: "Missing websocket token" });
        }

        const claims = await options.verifier.verify(token);
        let session: SignalingSession | null = null;

        const cleanup = async () => {
          if (!session) {
            return;
          }
          hub.unregister(session);
          hub.broadcastPeerLeft(session.lobbyCode, session.userId);
          await options.backend.markPresence(session.token, {
            lobbyCode: session.lobbyCode,
            connectionState: "disconnected",
          });
          session = null;
        };

        return {
          onMessage: (event, socket) => {
            void (async () => {
              try {
                const raw =
                  typeof event.data === "string"
                    ? JSON.parse(event.data)
                    : event.data;
                const message = signalingMessageSchema.parse(raw);

                if (message.type === "identify") {
                  const lobby = await options.backend.getLobbyView(
                    token,
                    message.lobbyCode,
                  );
                  ensureLobbyMembership(lobby, claims.sub);
                  await options.backend.markPresence(token, {
                    lobbyCode: message.lobbyCode,
                    connectionState: "connected",
                  });
                  session = {
                    lobbyCode: message.lobbyCode,
                    userId: claims.sub,
                    token,
                    socket,
                  };
                  hub.register(session);
                  return;
                }

                if (!session) {
                  socket.close(4401, "identify must be sent first");
                  return;
                }

                if (message.type === "peer-left") {
                  socket.close(4400, "peer-left is server generated");
                  return;
                }

                if (message.lobbyCode !== session.lobbyCode) {
                  socket.close(4400, "lobbyCode does not match identified lobby");
                  return;
                }

                if (message.targetUserId === session.userId) {
                  socket.close(4400, "cannot target self");
                  return;
                }

                if (message.type === "probe-complete") {
                  await options.backend.reportProbe(token, session.lobbyCode, {
                    targetUserId: message.targetUserId,
                    ...message.metrics,
                  });
                }

                hub.sendTo(session.lobbyCode, message.targetUserId, {
                  ...message,
                  sourceUserId: session.userId,
                });
              } catch {
                socket.close(4400, "invalid signaling payload");
              }
            })();
          },
          onClose: () => {
            void cleanup();
          },
          onError: () => {
            void cleanup();
          },
        };
      },
      { onError: () => undefined },
    ),
  );
};
