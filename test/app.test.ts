import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import type {
  LobbyPayload,
  MatchPlayerRealtimeStatePayload,
  MatchStatePayload,
  ShotFiredPayload,
} from "../src/domain.js";

type TestHarness = {
  app: FastifyInstance;
  advanceTime: (ms: number) => void;
  close: () => Promise<void>;
};

type JsonResponse<T> = {
  statusCode: number;
  body: T;
};

type AuthResponse = {
  token: string;
  user: {
    id: string;
    username: string;
    createdAt: string;
  };
};

type RealtimeMessage =
  | { type: "auth_ok" }
  | { type: "lobby_state"; lobby: LobbyPayload | null }
  | { type: "match_started"; match: NonNullable<LobbyPayload["activeMatch"]> }
  | { type: "match_state"; state: MatchStatePayload }
  | { type: "player_state"; player: MatchPlayerRealtimeStatePayload }
  | { type: "shot_fired"; shot: ShotFiredPayload }
  | { type: "match_ended"; reason: string }
  | { type: "error"; message: string };

async function createHarness(): Promise<TestHarness> {
  let now = new Date("2026-04-02T12:00:00.000Z");
  const app = buildApp({
    dbFilePath: ":memory:",
    now: () => now,
  });

  await app.ready();

  return {
    app,
    advanceTime(ms) {
      now = new Date(now.getTime() + ms);
    },
    async close() {
      await app.close();
    },
  };
}

async function requestJson<T>(
  responsePromise: Promise<LightMyRequestResponse>,
): Promise<JsonResponse<T>> {
  const response = await responsePromise;
  return {
    statusCode: response.statusCode,
    body: response.json<T>(),
  };
}

async function signUp(app: FastifyInstance, username: string, password = "password123") {
  return requestJson<AuthResponse>(
    app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        username,
        password,
      },
    }),
  );
}

async function signIn(app: FastifyInstance, username: string, password = "password123") {
  return requestJson<AuthResponse>(
    app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        username,
        password,
      },
    }),
  );
}

async function createLobbyRequest(
  app: FastifyInstance,
  token: string,
  selectedCharacterId = "trooper",
  selectedMapId = "range",
) {
  return requestJson<LobbyPayload>(
    app.inject({
      method: "POST",
      url: "/lobbies",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        maxPlayers: 2,
        selectedCharacterId,
        selectedMapId,
      },
    }),
  );
}

function waitForSocketMessage<T extends RealtimeMessage>(
  socket: WebSocket,
  predicate: (message: RealtimeMessage) => message is T,
) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message."));
    }, 4_000);

    const onMessage = (raw: WebSocket.RawData) => {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : raw instanceof Buffer
        ? raw.toString("utf8")
        : raw.toString();
      const message = JSON.parse(text) as RealtimeMessage;
      if (!predicate(message)) {
        return;
      }

      cleanup();
      resolve(message);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function connectRealtime(
  harness: TestHarness,
  token: string,
  code: string,
) {
  const socket = await harness.app.injectWS("/realtime", {
    headers: {
      origin: "http://localhost:1420",
    },
  });

  socket.send(JSON.stringify({
    type: "auth",
    token,
  }));
  await waitForSocketMessage(socket, (message): message is { type: "auth_ok" } =>
    message.type === "auth_ok"
  );

  socket.send(JSON.stringify({
    type: "subscribe_lobby",
    code,
  }));
  const initialLobbyState = await waitForSocketMessage(
    socket,
    (
      message,
    ): message is { type: "lobby_state"; lobby: LobbyPayload | null } => message.type === "lobby_state",
  );

  return {
    socket,
    initialLobbyState,
  };
}

function sendPlayerState(
  socket: WebSocket,
  overrides: Partial<MatchPlayerRealtimeStatePayload> & {
    seq: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
  },
) {
  socket.send(JSON.stringify({
    type: "player_state",
    seq: overrides.seq,
    x: overrides.x,
    y: overrides.y,
    z: overrides.z,
    yaw: overrides.yaw,
    pitch: overrides.pitch,
    moving: overrides.moving ?? false,
    sprinting: overrides.sprinting ?? false,
    crouched: overrides.crouched ?? false,
    grounded: overrides.grounded ?? true,
    ads: overrides.ads ?? false,
  }));
}

function sendFire(socket: WebSocket, shotId: string) {
  socket.send(JSON.stringify({
    type: "fire",
    shotId,
    weaponType: "rifle",
  }));
}

function sendReload(socket: WebSocket, requestId: string) {
  socket.send(JSON.stringify({
    type: "reload",
    requestId,
  }));
}

async function createStartedLiveMatch(
  harness: TestHarness,
  hostUsername: string,
  guestUsername: string,
) {
  const host = await signUp(harness.app, hostUsername);
  const guest = await signUp(harness.app, guestUsername);
  const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

  await requestJson<LobbyPayload>(
    harness.app.inject({
      method: "POST",
      url: "/lobbies/join",
      headers: {
        authorization: `Bearer ${guest.body.token}`,
      },
      payload: {
        code: lobby.body.code,
        selectedCharacterId: "terrorist",
      },
    }),
  );

  const hostRealtime = await connectRealtime(harness, host.body.token, lobby.body.code);
  const guestRealtime = await connectRealtime(harness, guest.body.token, lobby.body.code);

  await requestJson<LobbyPayload>(
    harness.app.inject({
      method: "POST",
      url: `/lobbies/${lobby.body.code}/ready`,
      headers: {
        authorization: `Bearer ${host.body.token}`,
      },
      payload: { ready: true },
    }),
  );
  await requestJson<LobbyPayload>(
    harness.app.inject({
      method: "POST",
      url: `/lobbies/${lobby.body.code}/ready`,
      headers: {
        authorization: `Bearer ${guest.body.token}`,
      },
      payload: { ready: true },
    }),
  );

  const hostStartedPromise = waitForSocketMessage(
    hostRealtime.socket,
    (message): message is { type: "match_started"; match: NonNullable<LobbyPayload["activeMatch"]> } =>
      message.type === "match_started",
  );
  const guestStartedPromise = waitForSocketMessage(
    guestRealtime.socket,
    (message): message is { type: "match_started"; match: NonNullable<LobbyPayload["activeMatch"]> } =>
      message.type === "match_started",
  );
  const hostMatchStatePromise = waitForSocketMessage(
    hostRealtime.socket,
    (message): message is { type: "match_state"; state: MatchStatePayload } =>
      message.type === "match_state",
  );
  const guestMatchStatePromise = waitForSocketMessage(
    guestRealtime.socket,
    (message): message is { type: "match_state"; state: MatchStatePayload } =>
      message.type === "match_state",
  );

  const startResponse = await requestJson<{ ok: boolean }>(
    harness.app.inject({
      method: "POST",
      url: `/lobbies/${lobby.body.code}/start`,
      headers: {
        authorization: `Bearer ${host.body.token}`,
      },
    }),
  );

  assert.equal(startResponse.statusCode, 200);
  assert.equal(startResponse.body.ok, true);

  const [hostStarted, guestStarted, hostMatchState, guestMatchState] = await Promise.all([
    hostStartedPromise,
    guestStartedPromise,
    hostMatchStatePromise,
    guestMatchStatePromise,
  ]);

  assert.equal(hostStarted.match.slots.length, 2);
  assert.equal(guestStarted.match.slots.length, 2);

  return {
    host,
    guest,
    lobby,
    hostRealtime,
    guestRealtime,
    hostMatchState: hostMatchState.state,
    guestMatchState: guestMatchState.state,
  };
}

test("sign up succeeds and duplicate usernames are rejected", async () => {
  const harness = await createHarness();
  try {
    const firstSignup = await signUp(harness.app, "TraceHost");
    assert.equal(firstSignup.statusCode, 201);
    assert.ok(firstSignup.body.token);
    assert.equal(firstSignup.body.user.username, "TraceHost");

    const duplicateSignup = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: {
          username: "tracehost",
          password: "password123",
        },
      }),
    );
    assert.equal(duplicateSignup.statusCode, 409);
    assert.equal(duplicateSignup.body.message, "That username is already taken.");
  } finally {
    await harness.close();
  }
});

test("login normalizes usernames and session lookup rejects invalid or expired tokens", async () => {
  const harness = await createHarness();
  try {
    const signup = await signUp(harness.app, "Agent_47");
    assert.equal(signup.statusCode, 201);

    const login = await signIn(harness.app, "agent_47");
    assert.equal(login.statusCode, 200);

    const session = await requestJson<{
      user: {
        username: string;
      };
    }>(
      harness.app.inject({
        method: "GET",
        url: "/auth/session",
        headers: {
          authorization: `Bearer ${login.body.token}`,
        },
      }),
    );

    assert.equal(session.statusCode, 200);
    assert.equal(session.body.user.username, "Agent_47");

    const invalidSession = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "GET",
        url: "/auth/session",
        headers: {
          authorization: "Bearer not-a-real-token",
        },
      }),
    );

    assert.equal(invalidSession.statusCode, 401);
    assert.equal(invalidSession.body.message, "Authentication is required.");

    harness.advanceTime(31 * 24 * 60 * 60 * 1000);

    const expiredSession = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "GET",
        url: "/auth/session",
        headers: {
          authorization: `Bearer ${signup.body.token}`,
        },
      }),
    );

    assert.equal(expiredSession.statusCode, 401);
  } finally {
    await harness.close();
  }
});

test("creating and joining a lobby persist selected character and map state", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "HostAlpha");
    const guest = await signUp(harness.app, "GuestBravo");

    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");
    assert.equal(lobby.statusCode, 200);
    assert.equal(lobby.body.maxPlayers, 2);
    assert.equal(lobby.body.selectedMapId, "map1");
    assert.equal(lobby.body.players[0]?.selectedCharacterId, "trooper");

    const joined = await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code.toLowerCase(),
          selectedCharacterId: "terrorist",
        },
      }),
    );

    assert.equal(joined.statusCode, 200);
    assert.equal(joined.body.players.length, 2);
    assert.equal(
      joined.body.players.find((player) => player.userId === guest.body.user.id)?.selectedCharacterId,
      "terrorist",
    );
  } finally {
    await harness.close();
  }
});

test("joining by code works, full lobbies reject extra joins, and bad codes fail", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "HostOne");
    const guest = await signUp(harness.app, "GuestOne");
    const intruder = await signUp(harness.app, "GuestTwo");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

    const joined = await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    assert.equal(joined.statusCode, 200);
    assert.equal(joined.body.players.length, 2);

    const full = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${intruder.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "stylish-man",
        },
      }),
    );

    assert.equal(full.statusCode, 409);
    assert.equal(full.body.message, "Lobby is full.");

    const missing = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${intruder.body.token}`,
        },
        payload: {
          code: "ZZZZZZ",
          selectedCharacterId: "stylish-man",
        },
      }),
    );

    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.message, "Lobby not found.");
  } finally {
    await harness.close();
  }
});

test("character change clears only that player's ready flag and host map change clears both ready flags", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "ReadyHost");
    const guest = await signUp(harness.app, "ReadyGuest");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
        payload: { ready: true },
      }),
    );
    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: { ready: true },
      }),
    );

    const changedCharacter = await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/character`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          selectedCharacterId: "trooper",
        },
      }),
    );

    assert.equal(changedCharacter.statusCode, 200);
    assert.equal(
      changedCharacter.body.players.find((player) => player.userId === host.body.user.id)?.isReady,
      true,
    );
    assert.equal(
      changedCharacter.body.players.find((player) => player.userId === guest.body.user.id)?.isReady,
      false,
    );

    const changedMap = await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/map`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
        payload: {
          selectedMapId: "map1",
        },
      }),
    );

    assert.equal(changedMap.statusCode, 200);
    assert.equal(changedMap.body.selectedMapId, "map1");
    assert.ok(changedMap.body.players.every((player) => player.isReady === false));
  } finally {
    await harness.close();
  }
});

test("non-host users cannot change the map or start the match", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "MapHost");
    const guest = await signUp(harness.app, "MapGuest");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    const nonHostMap = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/map`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          selectedMapId: "map1",
        },
      }),
    );

    assert.equal(nonHostMap.statusCode, 403);
    assert.equal(nonHostMap.body.message, "Only the host can change the map.");

    const nonHostStart = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/start`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
      }),
    );

    assert.equal(nonHostStart.statusCode, 403);
    assert.equal(nonHostStart.body.message, "Only the host can start the match.");
  } finally {
    await harness.close();
  }
});

test("websocket auth and subscribe yield lobby updates after REST mutations", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "SocketHost");
    const guest = await signUp(harness.app, "SocketGuest");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    const hostRealtime = await connectRealtime(harness, host.body.token, lobby.body.code);
    assert.equal(hostRealtime.initialLobbyState.lobby?.players.length, 2);

    const guestRealtime = await connectRealtime(harness, guest.body.token, lobby.body.code);
    assert.equal(guestRealtime.initialLobbyState.lobby?.players.length, 2);

    const hostUpdatePromise = waitForSocketMessage(
      hostRealtime.socket,
      (
        message,
      ): message is { type: "lobby_state"; lobby: LobbyPayload | null } =>
        message.type === "lobby_state" &&
        message.lobby?.players.some((player) =>
          player.userId === guest.body.user.id && player.selectedCharacterId === "trooper"
        ) === true,
    );
    const guestUpdatePromise = waitForSocketMessage(
      guestRealtime.socket,
      (
        message,
      ): message is { type: "lobby_state"; lobby: LobbyPayload | null } =>
        message.type === "lobby_state" &&
        message.lobby?.players.some((player) =>
          player.userId === guest.body.user.id && player.selectedCharacterId === "trooper"
        ) === true,
    );

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/character`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          selectedCharacterId: "trooper",
        },
      }),
    );

    const hostUpdate = await hostUpdatePromise;
    const guestUpdate = await guestUpdatePromise;

    assert.equal(hostUpdate.lobby?.players.length, 2);
    assert.equal(guestUpdate.lobby?.players.length, 2);

    hostRealtime.socket.terminate();
    guestRealtime.socket.terminate();
  } finally {
    await harness.close();
  }
});

test("match start requires both players ready and connected, then emits deterministic slots", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "StartHost");
    const guest = await signUp(harness.app, "StartGuest");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    const notConnectedStart = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/start`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
      }),
    );
    assert.equal(notConnectedStart.statusCode, 409);
    assert.equal(
      notConnectedStart.body.message,
      "Both players must be ready before starting.",
    );

    const hostRealtime = await connectRealtime(harness, host.body.token, lobby.body.code);
    const guestRealtime = await connectRealtime(harness, guest.body.token, lobby.body.code);

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
        payload: { ready: true },
      }),
    );
    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: { ready: true },
      }),
    );

    const hostStartedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_started"; match: NonNullable<LobbyPayload["activeMatch"]> } =>
        message.type === "match_started",
    );
    const hostLobbyStatePromise = waitForSocketMessage(
      hostRealtime.socket,
      (
        message,
      ): message is { type: "lobby_state"; lobby: LobbyPayload | null } =>
        message.type === "lobby_state" && message.lobby?.status === "in_match",
    );

    const startResponse = await requestJson<{ ok: boolean }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/start`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
      }),
    );

    assert.equal(startResponse.statusCode, 200);
    assert.equal(startResponse.body.ok, true);

    const hostStarted = await hostStartedPromise;
    const hostLobbyState = await hostLobbyStatePromise;

    assert.equal(hostStarted.match.slots[0]?.spawnSlot, "host");
    assert.equal(hostStarted.match.slots[0]?.userId, host.body.user.id);
    assert.equal(hostStarted.match.slots[1]?.spawnSlot, "guest");
    assert.equal(hostStarted.match.slots[1]?.userId, guest.body.user.id);
    assert.equal(hostLobbyState.lobby?.selectedMapId, "map1");

    hostRealtime.socket.terminate();
    guestRealtime.socket.terminate();
  } finally {
    await harness.close();
  }
});

test("socket disconnect during match emits match_ended and resets the lobby to open", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "DisconnectHost");
    const guest = await signUp(harness.app, "DisconnectGuest");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    const hostRealtime = await connectRealtime(harness, host.body.token, lobby.body.code);
    const guestRealtime = await connectRealtime(harness, guest.body.token, lobby.body.code);

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
        payload: { ready: true },
      }),
    );
    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: { ready: true },
      }),
    );

    const matchStartedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_started"; match: NonNullable<LobbyPayload["activeMatch"]> } =>
        message.type === "match_started",
    );

    await requestJson<{ ok: boolean }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/start`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
      }),
    );

    await matchStartedPromise;

    const endedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_ended"; reason: string } =>
        message.type === "match_ended",
    );
    const reopenedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (
        message,
      ): message is { type: "lobby_state"; lobby: LobbyPayload | null } =>
        message.type === "lobby_state" && message.lobby?.status === "open",
    );

    guestRealtime.socket.terminate();

    const ended = await endedPromise;
    const reopened = await reopenedPromise;

    assert.equal(ended.reason, "player_disconnected");
    assert.equal(reopened.lobby?.activeMatch, null);
    assert.ok(reopened.lobby?.players.every((player) => player.isReady === false));

    hostRealtime.socket.terminate();
  } finally {
    await harness.close();
  }
});

test("leaving during a live match removes the leaver and returns the remaining player to the lobby", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "LeaveHost");
    const guest = await signUp(harness.app, "LeaveGuest");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "map1");

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    const hostRealtime = await connectRealtime(harness, host.body.token, lobby.body.code);
    const guestRealtime = await connectRealtime(harness, guest.body.token, lobby.body.code);

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
        payload: { ready: true },
      }),
    );
    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: { ready: true },
      }),
    );

    const matchStartedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_started"; match: NonNullable<LobbyPayload["activeMatch"]> } =>
        message.type === "match_started",
    );

    await requestJson<{ ok: boolean }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/start`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
      }),
    );

    await matchStartedPromise;

    const endedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_ended"; reason: string } =>
        message.type === "match_ended",
    );
    const reopenedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (
        message,
      ): message is { type: "lobby_state"; lobby: LobbyPayload | null } =>
        message.type === "lobby_state" && message.lobby?.status === "open",
    );

    const leave = await requestJson<{ ok: boolean }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/leave`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
      }),
    );

    assert.equal(leave.statusCode, 200);

    const ended = await endedPromise;
    const reopened = await reopenedPromise;

    assert.equal(ended.reason, "player_left");
    assert.equal(reopened.lobby?.players.length, 1);
    assert.equal(reopened.lobby?.players[0]?.userId, host.body.user.id);

    hostRealtime.socket.terminate();
    guestRealtime.socket.terminate();
  } finally {
    await harness.close();
  }
});

test("live multiplayer start is limited to map1", async () => {
  const harness = await createHarness();
  try {
    const host = await signUp(harness.app, "MapOneOnlyHost");
    const guest = await signUp(harness.app, "MapOneOnlyGuest");
    const lobby = await createLobbyRequest(harness.app, host.body.token, "trooper", "range");

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: "/lobbies/join",
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: {
          code: lobby.body.code,
          selectedCharacterId: "terrorist",
        },
      }),
    );

    const hostRealtime = await connectRealtime(harness, host.body.token, lobby.body.code);
    const guestRealtime = await connectRealtime(harness, guest.body.token, lobby.body.code);

    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
        payload: { ready: true },
      }),
    );
    await requestJson<LobbyPayload>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/ready`,
        headers: {
          authorization: `Bearer ${guest.body.token}`,
        },
        payload: { ready: true },
      }),
    );

    const start = await requestJson<{ message: string }>(
      harness.app.inject({
        method: "POST",
        url: `/lobbies/${lobby.body.code}/start`,
        headers: {
          authorization: `Bearer ${host.body.token}`,
        },
      }),
    );

    assert.equal(start.statusCode, 409);
    assert.equal(start.body.message, "Live multiplayer combat is only wired for map1 right now.");

    hostRealtime.socket.terminate();
    guestRealtime.socket.terminate();
  } finally {
    await harness.close();
  }
});

test("live player_state broadcasts accepted movement and rejects impossible teleports", async () => {
  const harness = await createHarness();
  let hostRealtime: Awaited<ReturnType<typeof connectRealtime>> | null = null;
  let guestRealtime: Awaited<ReturnType<typeof connectRealtime>> | null = null;

  try {
    const match = await createStartedLiveMatch(harness, "MoveHost", "MoveGuest");
    hostRealtime = match.hostRealtime;
    guestRealtime = match.guestRealtime;

    harness.advanceTime(10_000);

    const mirroredMovePromise = waitForSocketMessage(
      guestRealtime.socket,
      (message): message is { type: "player_state"; player: MatchPlayerRealtimeStatePayload } =>
        message.type === "player_state" &&
        message.player.userId === match.host.body.user.id &&
        message.player.seq === 1,
    );

    sendPlayerState(hostRealtime.socket, {
      seq: 1,
      x: 28,
      y: 0.5,
      z: -25,
      yaw: Math.PI,
      pitch: 0,
      moving: true,
      sprinting: true,
      crouched: false,
      grounded: true,
      ads: false,
    });

    const mirroredMove = await mirroredMovePromise;
    assert.equal(mirroredMove.player.x, 28);
    assert.equal(mirroredMove.player.z, -25);
    assert.equal(mirroredMove.player.sprinting, true);

    const teleportRejectedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "error"; message: string } =>
        message.type === "error" &&
        message.message === "Movement update rejected as an impossible teleport.",
    );

    sendPlayerState(hostRealtime.socket, {
      seq: 2,
      x: -28,
      y: 0.5,
      z: 25,
      yaw: 0,
      pitch: 0,
      moving: true,
      sprinting: true,
      crouched: false,
      grounded: true,
      ads: false,
    });

    const teleportRejected = await teleportRejectedPromise;
    assert.equal(teleportRejected.message, "Movement update rejected as an impossible teleport.");
  } finally {
    hostRealtime?.socket.terminate();
    guestRealtime?.socket.terminate();
    await harness.close();
  }
});

test("backend-confirmed headshots kill players and respawn them after three seconds", async () => {
  const harness = await createHarness();
  let hostRealtime: Awaited<ReturnType<typeof connectRealtime>> | null = null;
  let guestRealtime: Awaited<ReturnType<typeof connectRealtime>> | null = null;

  try {
    const match = await createStartedLiveMatch(harness, "CombatHost", "CombatGuest");
    hostRealtime = match.hostRealtime;
    guestRealtime = match.guestRealtime;

    harness.advanceTime(10_000);

    const hostMirrorPromise = waitForSocketMessage(
      guestRealtime.socket,
      (message): message is { type: "player_state"; player: MatchPlayerRealtimeStatePayload } =>
        message.type === "player_state" &&
        message.player.userId === match.host.body.user.id &&
        message.player.seq === 1,
    );
    const guestMirrorPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "player_state"; player: MatchPlayerRealtimeStatePayload } =>
        message.type === "player_state" &&
        message.player.userId === match.guest.body.user.id &&
        message.player.seq === 1,
    );

    sendPlayerState(hostRealtime.socket, {
      seq: 1,
      x: 28,
      y: 0.5,
      z: -25,
      yaw: Math.PI,
      pitch: 0.012,
      moving: false,
      sprinting: false,
      crouched: false,
      grounded: true,
      ads: true,
    });
    sendPlayerState(guestRealtime.socket, {
      seq: 1,
      x: 28,
      y: 0.5,
      z: -15,
      yaw: 0,
      pitch: 0,
      moving: false,
      sprinting: false,
      crouched: false,
      grounded: true,
      ads: false,
    });

    await hostMirrorPromise;
    await guestMirrorPromise;

    const shotPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "shot_fired"; shot: ShotFiredPayload } =>
        message.type === "shot_fired" &&
        message.shot.shotId === "headshot-1",
    );
    const killStatePromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_state"; state: MatchStatePayload } =>
        message.type === "match_state" &&
        message.state.players.some((player) =>
          player.userId === match.guest.body.user.id &&
          player.alive === false &&
          player.health === 0
        ),
    );

    sendFire(hostRealtime.socket, "headshot-1");

    const shot = await shotPromise;
    const killState = await killStatePromise;
    const killedGuest = killState.state.players.find((player) => player.userId === match.guest.body.user.id);

    assert.equal(shot.shot.hit?.userId, match.guest.body.user.id);
    assert.equal(shot.shot.hit?.zone, "head");
    assert.equal(shot.shot.hit?.damage, 125);
    assert.equal(shot.shot.hit?.killed, true);
    assert.equal(killedGuest?.respawnAt !== null, true);

    harness.advanceTime(3_100);

    const respawnStatePromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_state"; state: MatchStatePayload } =>
        message.type === "match_state" &&
        message.state.players.some((player) =>
          player.userId === match.guest.body.user.id &&
          player.alive === true &&
          player.health === 100 &&
          player.magAmmo === 30 &&
          player.respawnAt === null
        ),
    );
    const respawnPosePromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "player_state"; player: MatchPlayerRealtimeStatePayload } =>
        message.type === "player_state" &&
        message.player.userId === match.guest.body.user.id &&
        message.player.alive === true &&
        Math.abs(message.player.x) < 0.01 &&
        Math.abs(message.player.z - 50) < 0.01,
    );

    sendPlayerState(hostRealtime.socket, {
      seq: 2,
      x: 28,
      y: 0.5,
      z: -25,
      yaw: Math.PI,
      pitch: 0,
      moving: false,
      sprinting: false,
      crouched: false,
      grounded: true,
      ads: false,
    });

    const respawnState = await respawnStatePromise;
    const respawnPose = await respawnPosePromise;
    const respawnedGuest = respawnState.state.players.find((player) => player.userId === match.guest.body.user.id);

    assert.equal(respawnedGuest?.alive, true);
    assert.equal(respawnedGuest?.health, 100);
    assert.equal(respawnedGuest?.magAmmo, 30);
    assert.equal(respawnPose.player.alive, true);
  } finally {
    hostRealtime?.socket.terminate();
    guestRealtime?.socket.terminate();
    await harness.close();
  }
});

test("coarse blockers stop rifle damage and reload timing stays authoritative", async () => {
  const harness = await createHarness();
  let hostRealtime: Awaited<ReturnType<typeof connectRealtime>> | null = null;
  let guestRealtime: Awaited<ReturnType<typeof connectRealtime>> | null = null;

  try {
    const match = await createStartedLiveMatch(harness, "ReloadHost", "ReloadGuest");
    hostRealtime = match.hostRealtime;
    guestRealtime = match.guestRealtime;

    harness.advanceTime(10_000);

    const hostMirrorPromise = waitForSocketMessage(
      guestRealtime.socket,
      (message): message is { type: "player_state"; player: MatchPlayerRealtimeStatePayload } =>
        message.type === "player_state" &&
        message.player.userId === match.host.body.user.id &&
        message.player.seq === 1,
    );
    const guestMirrorPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "player_state"; player: MatchPlayerRealtimeStatePayload } =>
        message.type === "player_state" &&
        message.player.userId === match.guest.body.user.id &&
        message.player.seq === 1,
    );

    sendPlayerState(hostRealtime.socket, {
      seq: 1,
      x: 0,
      y: 0.5,
      z: -40,
      yaw: Math.PI,
      pitch: 0,
      moving: false,
      sprinting: false,
      crouched: false,
      grounded: true,
      ads: true,
    });
    sendPlayerState(guestRealtime.socket, {
      seq: 1,
      x: 0,
      y: 0.5,
      z: -25,
      yaw: 0,
      pitch: 0,
      moving: false,
      sprinting: false,
      crouched: false,
      grounded: true,
      ads: false,
    });

    await hostMirrorPromise;
    await guestMirrorPromise;

    const blockedShotPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "shot_fired"; shot: ShotFiredPayload } =>
        message.type === "shot_fired" &&
        message.shot.shotId === "blocked-1",
    );
    const blockedStatePromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_state"; state: MatchStatePayload } =>
        message.type === "match_state" &&
        message.state.players.some((player) =>
          player.userId === match.host.body.user.id &&
          player.magAmmo === 29
        ),
    );

    sendFire(hostRealtime.socket, "blocked-1");

    const blockedShot = await blockedShotPromise;
    const blockedState = await blockedStatePromise;
    const blockedGuest = blockedState.state.players.find((player) => player.userId === match.guest.body.user.id);

    assert.equal(blockedShot.shot.hit, null);
    assert.equal(blockedGuest?.health, 100);
    assert.equal(blockedGuest?.alive, true);

    const reloadStartedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_state"; state: MatchStatePayload } =>
        message.type === "match_state" &&
        message.state.players.some((player) =>
          player.userId === match.host.body.user.id &&
          player.magAmmo === 29 &&
          player.reloadingUntil !== null
        ),
    );

    sendReload(hostRealtime.socket, "reload-1");

    const reloadStarted = await reloadStartedPromise;
    const reloadingHost = reloadStarted.state.players.find((player) => player.userId === match.host.body.user.id);
    assert.equal(reloadingHost?.reloadingUntil !== null, true);

    harness.advanceTime(3_100);

    const reloadFinishedPromise = waitForSocketMessage(
      hostRealtime.socket,
      (message): message is { type: "match_state"; state: MatchStatePayload } =>
        message.type === "match_state" &&
        message.state.players.some((player) =>
          player.userId === match.host.body.user.id &&
          player.magAmmo === 30 &&
          player.reloadingUntil === null
        ),
    );

    sendPlayerState(hostRealtime.socket, {
      seq: 2,
      x: 0,
      y: 0.5,
      z: -40,
      yaw: Math.PI,
      pitch: 0,
      moving: false,
      sprinting: false,
      crouched: false,
      grounded: true,
      ads: false,
    });

    const reloadFinished = await reloadFinishedPromise;
    const finishedHost = reloadFinished.state.players.find((player) => player.userId === match.host.body.user.id);
    assert.equal(finishedHost?.magAmmo, 30);
    assert.equal(finishedHost?.reloadingUntil, null);
  } finally {
    hostRealtime?.socket.terminate();
    guestRealtime?.socket.terminate();
    await harness.close();
  }
});
