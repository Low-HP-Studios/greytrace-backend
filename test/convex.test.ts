/// <reference types="vite/client" />
// DEPRECATED: greytrace-backend is retired; do not use.

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

test("sign up and read session", async () => {
  const t = convexTest(schema, modules);
  const out = await t.mutation(api.auth.signUp, {
    username: "alice",
    password: "password123",
  });
  expect(out.user.username).toBe("alice");
  const session = await t.query(api.auth.getSession, {
    sessionToken: out.token,
  });
  expect(session?.user.username).toBe("alice");
});

test("create lobby requires heartbeat before start", async () => {
  const t = convexTest(schema, modules);
  const host = await t.mutation(api.auth.signUp, {
    username: "hostuser",
    password: "password123",
  });
  const guest = await t.mutation(api.auth.signUp, {
    username: "guestuser",
    password: "password123",
  });

  const lobby = await t.mutation(api.lobbies.createLobby, {
    sessionToken: host.token,
    maxPlayers: 2,
    selectedCharacterId: "stylish-man",
    selectedMapId: "map1",
  });
  if (!lobby) {
    throw new Error("expected lobby");
  }

  await t.mutation(api.lobbies.joinLobby, {
    sessionToken: guest.token,
    code: lobby.code,
    selectedCharacterId: "stylish-man",
  });

  await t.mutation(api.lobbies.setReady, {
    sessionToken: host.token,
    code: lobby.code,
    ready: true,
  });
  await t.mutation(api.lobbies.setReady, {
    sessionToken: guest.token,
    code: lobby.code,
    ready: true,
  });

  await expect(
    t.mutation(api.lobbies.startMatch, {
      sessionToken: host.token,
      code: lobby.code,
      hostAddress: "127.0.0.1",
      hostPort: 7777,
    }),
  ).rejects.toThrow();

  await t.mutation(api.presence.heartbeat, {
    sessionToken: host.token,
    lobbyCode: lobby.code,
  });
  await t.mutation(api.presence.heartbeat, {
    sessionToken: guest.token,
    lobbyCode: lobby.code,
  });

  await t.mutation(api.lobbies.startMatch, {
    sessionToken: host.token,
    code: lobby.code,
    hostAddress: "127.0.0.1",
    hostPort: 7777,
  });

  const updatedLobby = await t.query(api.lobbies.getLobby, {
    sessionToken: host.token,
    code: lobby.code,
  });
  expect(updatedLobby?.status).toBe("in_match");
  expect(updatedLobby?.activeMatch?.hostAddress).toBe("127.0.0.1");
  expect(updatedLobby?.activeMatch?.hostPort).toBe(7777);
  expect(updatedLobby?.activeMatch?.protocolVersion).toBe(1);
  expect(updatedLobby?.activeMatch?.slots).toEqual([
    {
      userId: host.user.id,
      slotIndex: 0,
      selectedCharacterId: "stylish-man",
    },
    {
      userId: guest.user.id,
      slotIndex: 1,
      selectedCharacterId: "stylish-man",
    },
  ]);
});

test("finalize hosted match reopens the lobby with an end reason", async () => {
  const t = convexTest(schema, modules);
  const host = await t.mutation(api.auth.signUp, {
    username: "hostlive",
    password: "password123",
  });
  const guest = await t.mutation(api.auth.signUp, {
    username: "guestlive",
    password: "password123",
  });

  const lobby = await t.mutation(api.lobbies.createLobby, {
    sessionToken: host.token,
    maxPlayers: 2,
    selectedCharacterId: "stylish-man",
    selectedMapId: "map1",
  });
  if (!lobby) {
    throw new Error("expected lobby");
  }

  await t.mutation(api.lobbies.joinLobby, {
    sessionToken: guest.token,
    code: lobby.code,
    selectedCharacterId: "stylish-man",
  });

  await t.mutation(api.lobbies.setReady, {
    sessionToken: host.token,
    code: lobby.code,
    ready: true,
  });
  await t.mutation(api.lobbies.setReady, {
    sessionToken: guest.token,
    code: lobby.code,
    ready: true,
  });

  await t.mutation(api.presence.heartbeat, {
    sessionToken: host.token,
    lobbyCode: lobby.code,
  });
  await t.mutation(api.presence.heartbeat, {
    sessionToken: guest.token,
    lobbyCode: lobby.code,
  });

  await t.mutation(api.lobbies.startMatch, {
    sessionToken: host.token,
    code: lobby.code,
    hostAddress: "10.0.0.5",
    hostPort: 9001,
  });

  await t.mutation(api.lobbies.finalizeHostedMatch, {
    sessionToken: host.token,
    code: lobby.code,
    reason: "host_ended_match",
  });

  const reopenedLobby = await t.query(api.lobbies.getLobby, {
    sessionToken: host.token,
    code: lobby.code,
  });

  expect(reopenedLobby?.status).toBe("open");
  expect(reopenedLobby?.activeMatch).toBeNull();
  expect(reopenedLobby?.lastMatchEndedReason).toBe("host_ended_match");
});
