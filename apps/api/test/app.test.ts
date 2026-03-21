import type { BackendService } from "@greytrace/api/src/types";
import type { AuthClaims, LobbyView, MatchView } from "@greytrace/contracts";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const authClaims: AuthClaims = {
  sub: "user-1",
  sessionId: "session-1",
  username: "ghost",
  displayUsername: "Ghost",
  name: "Ghost",
  email: "ghost@example.com",
  iss: "https://example.convex.site",
  aud: "convex",
  exp: 9_999_999_999,
  iat: 1_700_000_000,
};

const lobbyView: LobbyView = {
  id: "lobby-1",
  code: "ABC123",
  status: "forming",
  mode: "tdm",
  mapId: "range",
  maxPlayers: 6,
  ownerUserId: "user-1",
  hostUserId: null,
  matchId: null,
  createdAt: 1_700_000_000_000,
  members: [
    {
      userId: "user-1",
      username: "ghost",
      displayName: "Ghost",
      slot: 0,
      ready: false,
      team: null,
      joinedAt: 1_700_000_000_000,
      connectionState: "connected",
    },
  ],
  probeSummary: {
    expectedReports: 0,
    receivedReports: 0,
    deadlineAt: null,
  },
};

const matchView: MatchView = {
  id: "match-1",
  lobbyId: "lobby-1",
  hostUserId: "user-1",
  status: "live",
  scoreAlpha: 0,
  scoreBravo: 0,
  startedAt: 1_700_000_000_000,
  endedAt: null,
  lastEventSeq: 0,
  players: [
    {
      userId: "user-1",
      username: "ghost",
      displayName: "Ghost",
      team: "alpha",
    },
  ],
  events: [],
};

const currentUser = {
  id: "user-1",
  authUserId: "user-1",
  username: "ghost",
  displayName: "Ghost",
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_000_000,
};

const createBackend = (): BackendService => ({
  ensureCurrentUser: vi.fn(async () => currentUser),
  createLobby: vi.fn(async () => lobbyView),
  joinLobby: vi.fn(async () => lobbyView),
  leaveLobby: vi.fn(async () => lobbyView),
  setReady: vi.fn(async () => lobbyView),
  startProbe: vi.fn(async () => lobbyView),
  reportProbe: vi.fn(async () => lobbyView),
  getLobbyView: vi.fn(async () => lobbyView),
  startMatch: vi.fn(async () => matchView),
  getMatchView: vi.fn(async () => matchView),
  appendMatchEvents: vi.fn(async () => matchView),
  markPresence: vi.fn(async () => currentUser),
});

describe("api app", () => {
  const createTestApp = (fetchImpl = vi.fn()) =>
    createApp({
      config: {
        PORT: 8787,
        CORS_ORIGIN: "http://localhost:1420",
        CONVEX_URL: "https://example.convex.cloud",
        CONVEX_SITE_URL: "https://example.convex.site",
        BETTER_AUTH_URL: "https://example.convex.site",
        TURN_URLS: "turn:relay.example.com:3478?transport=udp",
        TURN_USERNAME: "user",
        TURN_CREDENTIAL: "pass",
        turn: {
          iceServers: [
            {
              urls: ["turn:relay.example.com:3478?transport=udp"],
              username: "user",
              credential: "pass",
            },
          ],
        },
      },
      backend: createBackend(),
      verifier: {
        verify: vi.fn(async () => authClaims),
      } as never,
      fetchImpl: fetchImpl as typeof fetch,
    });

  it("rejects protected routes without auth", async () => {
    const app = createTestApp();
    const response = await app.request("http://localhost/api/me");

    expect(response.status).toBe(401);
  });

  it("wraps username signup into Better Auth email signup", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(init?.body as BodyInit, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const app = createTestApp(fetchImpl);

    const response = await app.request("http://localhost/api/auth/sign-up/username", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "Ghost_1",
        password: "supersecret",
        displayUsername: "Ghost One",
      }),
    });

    const payload = await response.json();
    expect(payload).toEqual({
      email: "ghost_1@users.greytrace.local",
      password: "supersecret",
      name: "Ghost One",
      username: "Ghost_1",
      displayUsername: "Ghost One",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects invalid probe payloads before they hit the backend", async () => {
    const app = createTestApp();
    const response = await app.request("http://localhost/api/lobbies/ABC123/report-probe", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        targetUserId: "user-2",
        medianRttMs: 10,
        maxRttMs: 20,
        jitterMs: 3,
        lossPct: 101,
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects invalid match event payloads before the backend call", async () => {
    const app = createTestApp();
    const response = await app.request("http://localhost/api/matches/match-1/events", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        events: [{ seq: 1, type: "kill" }],
      }),
    });

    expect(response.status).toBe(400);
  });

  it("returns TURN config alongside probe start", async () => {
    const app = createTestApp();
    const response = await app.request("http://localhost/api/lobbies/ABC123/start-probe", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.turn.iceServers[0].urls[0]).toContain("relay.example.com");
  });
});
