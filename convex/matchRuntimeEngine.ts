// DEPRECATED: greytrace-backend is retired; do not use.

import type {
  LobbyPayload,
  MatchHitZone,
  MatchMapId,
  MatchPlayerRealtimeStatePayload,
  MatchPlayerStatePayload,
  MatchStatePayload,
  ShotFiredPayload,
} from "./domain";
import { HttpError } from "./lib/httpError";

const MATCH_MAP_ID: MatchMapId = "map1";
const MATCH_MAX_HEALTH = 100;
const MATCH_MAX_MAG_AMMO = 30;
const MATCH_FIRE_INTERVAL_MS = 130;
const MATCH_RELOAD_MS = 3_000;
const MATCH_RESPAWN_MS = 3_000;
const MAP1_JUMP_PAD_BOOST = 35;
const MAP1_JUMP_PAD_LAUNCH_SPEED = 21;
const MAX_GROUNDED_POSITION_STEP_METERS = 1.25;
const MAX_AIRBORNE_POSITION_STEP_METERS = 1.6;
const MAX_JUMP_PAD_POSITION_STEP_METERS = 2.4;
const MAX_GROUNDED_SPEED_MPS = 12;
const MAX_AIRBORNE_SPEED_MPS = 18;
const MAX_JUMP_PAD_SPEED_MPS = Math.hypot(
  MAP1_JUMP_PAD_LAUNCH_SPEED,
  MAP1_JUMP_PAD_BOOST,
) + 2;
const PLAYER_BLOCKER_MARGIN = 0.2;
const WORLD_Y_MIN = -2;
const DEFAULT_WORLD_Y_MAX = 6;
const JUMP_PAD_WORLD_Y_MAX = 26;
const JUMP_PAD_DETECTION_MAX_Y = 1.4;
const JUMP_PAD_GRACE_MS = 2_500;

type MatchSlotIndex = MatchPlayerStatePayload["slotIndex"];

type MatchPlayerPoseState = Omit<MatchPlayerRealtimeStatePayload, "userId" | "alive"> & {
  updatedAtMs: number;
};

export type MatchPlayerRuntime = {
  userId: string;
  slotIndex: MatchSlotIndex;
  pose: MatchPlayerPoseState;
  health: number;
  alive: boolean;
  respawnAtMs: number | null;
  magAmmo: number;
  reloadingUntilMs: number | null;
  lastShotAtMs: number | null;
  jumpPadGraceUntilMs: number | null;
};

export type MatchRuntime = {
  code: string;
  startedAt: string;
  mapId: MatchMapId;
  players: Map<string, MatchPlayerRuntime>;
};

type Point3 = {
  x: number;
  y: number;
  z: number;
};

type MatchHitSphere = {
  zone: MatchHitZone;
  center: Point3;
  radius: number;
};

type BlockingVolume = {
  center: [number, number, number];
  size: [number, number, number];
};

type JumpPadVolume = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
};

type WorldBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type IncomingPlayerState = Omit<MatchPlayerRealtimeStatePayload, "userId" | "alive">;

export type MatchRuntimeOutcome = {
  matchState: MatchStatePayload | null;
  playerStates: MatchPlayerRealtimeStatePayload[];
  shotFired: ShotFiredPayload | null;
};

export type MatchRuntimeManager = {
  createMatch: (code: string, lobby: LobbyPayload) => MatchStatePayload;
  loadSerialized: (serialized: string) => void;
  serializeCurrent: (code: string) => string | null;
  destroyMatch: (code: string) => void;
  destroyAll: () => void;
  getMatchState: (code: string) => MatchStatePayload | null;
  getPlayerStates: (code: string) => MatchPlayerRealtimeStatePayload[];
  handlePlayerState: (
    code: string,
    userId: string,
    state: IncomingPlayerState,
    now: Date,
  ) => MatchRuntimeOutcome;
  handleFire: (
    code: string,
    userId: string,
    shotId: string,
    weaponType: "rifle",
    now: Date,
  ) => MatchRuntimeOutcome;
  handleReload: (code: string, userId: string, now: Date) => MatchRuntimeOutcome;
};

function wall(
  cx: number,
  cz: number,
  sx: number,
  sz: number,
  h = 3.8,
): BlockingVolume {
  return { center: [cx, h / 2, cz], size: [sx, h, sz] };
}

function crate(
  cx: number,
  cz: number,
  sx: number,
  sz: number,
  h = 2.6,
): BlockingVolume {
  return { center: [cx, h / 2, cz], size: [sx, h, sz] };
}

const MAP1_PLAYER_BOUNDS: WorldBounds = {
  minX: -41.85,
  maxX: 41.85,
  minZ: -54.85,
  maxZ: 54.85,
};

const MAP1_JUMP_PAD_WIDTH = 8 * Math.sqrt(0.6);
const MAP1_JUMP_PAD_DEPTH = 6 * Math.sqrt(0.6);

function jumpPad(centerX: number, centerZ: number): JumpPadVolume {
  const halfWidth = MAP1_JUMP_PAD_WIDTH / 2;
  const halfDepth = MAP1_JUMP_PAD_DEPTH / 2;
  return {
    minX: centerX - halfWidth,
    maxX: centerX + halfWidth,
    minZ: centerZ - halfDepth,
    maxZ: centerZ + halfDepth,
    y: 0,
  };
}

const MAP1_JUMP_PADS: readonly JumpPadVolume[] = [
  jumpPad(-31, -40),
  jumpPad(31, -40),
  jumpPad(-31, 40),
  jumpPad(31, 40),
];

const MAP1_BLOCKERS: readonly BlockingVolume[] = [
  wall(0, -55, 84, 0.3),
  wall(0, 55, 84, 0.3),
  wall(-42, 0, 0.3, 110),
  wall(42, 0, 0.3, 110),
  wall(0, -33, 40, 0.3),
  wall(0, 33, 40, 0.3),
  wall(-14, -18, 20, 0.3),
  wall(14, -18, 20, 0.3),
  wall(-14, 18, 20, 0.3),
  wall(14, 18, 20, 0.3),
  wall(-24, -11, 0.3, 14),
  wall(-24, 11, 0.3, 14),
  wall(24, -11, 0.3, 14),
  wall(24, 11, 0.3, 14),
  {
    center: [0, 3.95, 0],
    size: [48, 0.3, 36],
  },
  crate(-12, -6, 6, 6),
  crate(12, 6, 6, 6),
  crate(-33, -24, 5, 5),
  crate(33, -24, 5, 5),
  crate(-33, 24, 5, 5),
  crate(33, 24, 5, 5),
];

const MAP1_SPAWNS = [
  {
    position: [0, 0.5, -50] as [number, number, number],
    yaw: Math.PI,
    pitch: -0.05,
  },
  {
    position: [0, 0.5, 50] as [number, number, number],
    yaw: 0,
    pitch: -0.05,
  },
] as const;

function resolveSpawnConfig(slotIndex: number) {
  const spawn = MAP1_SPAWNS[slotIndex];
  if (spawn) {
    return spawn;
  }

  const ringIndex = Math.max(0, slotIndex - MAP1_SPAWNS.length);
  const angle = (ringIndex / 6) * Math.PI * 2;
  const radius = 26;
  return {
    position: [
      Math.round(Math.sin(angle) * radius * 10) / 10,
      0.5,
      Math.round(Math.cos(angle) * radius * 10) / 10,
    ] as [number, number, number],
    yaw: normalizeAngleRadians(angle + Math.PI),
    pitch: -0.05,
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function toIso(ms: number) {
  return new Date(ms).toISOString();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeAngleRadians(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const twoPi = Math.PI * 2;
  let normalized = value % twoPi;
  if (normalized > Math.PI) {
    normalized -= twoPi;
  } else if (normalized < -Math.PI) {
    normalized += twoPi;
  }
  return normalized;
}

function createSpawnPose(
  slotIndex: MatchSlotIndex,
  updatedAtMs: number,
  seq = 0,
): MatchPlayerPoseState {
  const spawn = resolveSpawnConfig(slotIndex);
  return {
    slotIndex,
    seq,
    x: spawn.position[0],
    y: spawn.position[1],
    z: spawn.position[2],
    yaw: spawn.yaw,
    bodyYaw: spawn.yaw,
    pitch: spawn.pitch,
    moving: false,
    sprinting: false,
    crouched: false,
    grounded: true,
    ads: false,
    animState: "rifleIdle",
    locomotionScale: 1,
    lowerBodyState: null,
    lowerBodyLocomotionScale: 1,
    upperBodyState: null,
    updatedAtMs,
  };
}

function buildRealtimePlayerState(player: MatchPlayerRuntime): MatchPlayerRealtimeStatePayload {
  return {
    userId: player.userId,
    slotIndex: player.slotIndex,
    seq: player.pose.seq,
    x: player.pose.x,
    y: player.pose.y,
    z: player.pose.z,
    yaw: player.pose.yaw,
    bodyYaw: player.pose.bodyYaw,
    pitch: player.pose.pitch,
    moving: player.pose.moving,
    sprinting: player.pose.sprinting,
    crouched: player.pose.crouched,
    grounded: player.pose.grounded,
    ads: player.pose.ads,
    animState: player.pose.animState,
    locomotionScale: player.pose.locomotionScale,
    lowerBodyState: player.pose.lowerBodyState,
    lowerBodyLocomotionScale: player.pose.lowerBodyLocomotionScale,
    upperBodyState: player.pose.upperBodyState,
    alive: player.alive,
  };
}

function buildMatchPlayerState(player: MatchPlayerRuntime): MatchPlayerStatePayload {
  return {
    userId: player.userId,
    slotIndex: player.slotIndex,
    health: player.health,
    alive: player.alive,
    respawnAt: player.respawnAtMs === null ? null : toIso(player.respawnAtMs),
    magAmmo: player.magAmmo,
    reloadingUntil: player.reloadingUntilMs === null ? null : toIso(player.reloadingUntilMs),
  };
}

function buildMatchState(match: MatchRuntime): MatchStatePayload {
  return {
    startedAt: match.startedAt,
    mapId: match.mapId,
    players: [...match.players.values()]
      .sort((left, right) => left.slotIndex - right.slotIndex)
      .map(buildMatchPlayerState),
  };
}

function buildPoint(x: number, y: number, z: number): Point3 {
  return { x, y, z };
}

function subtractPoint(left: Point3, right: Point3): Point3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function pointLength(point: Point3) {
  return Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
}

function normalizePoint(point: Point3): Point3 {
  const length = pointLength(point);
  if (length <= 0.0001) {
    return { x: 0, y: 0, z: -1 };
  }

  return {
    x: point.x / length,
    y: point.y / length,
    z: point.z / length,
  };
}

function distanceBetween(a: Point3, b: Point3) {
  return pointLength(subtractPoint(a, b));
}

function directionFromYawPitch(yaw: number, pitch: number): Point3 {
  const clampedPitch = Math.max(-1.5, Math.min(0.85, pitch));
  const cosPitch = Math.cos(clampedPitch);
  return normalizePoint({
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(clampedPitch),
    z: -Math.cos(yaw) * cosPitch,
  });
}

function intersectRaySphere(
  origin: Point3,
  direction: Point3,
  center: Point3,
  radius: number,
): number | null {
  const oc = subtractPoint(origin, center);
  const b = oc.x * direction.x + oc.y * direction.y + oc.z * direction.z;
  const c = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) {
    return null;
  }

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const near = -b - sqrtDiscriminant;
  if (near >= 0) {
    return near;
  }
  const far = -b + sqrtDiscriminant;
  return far >= 0 ? far : null;
}

function intersectRayAabb(
  origin: Point3,
  direction: Point3,
  blocker: BlockingVolume,
): number | null {
  const [cx, cy, cz] = blocker.center;
  const [sx, sy, sz] = blocker.size;
  const minX = cx - sx / 2;
  const maxX = cx + sx / 2;
  const minY = cy - sy / 2;
  const maxY = cy + sy / 2;
  const minZ = cz - sz / 2;
  const maxZ = cz + sz / 2;

  let tMin = 0;
  let tMax = Number.POSITIVE_INFINITY;
  const axes: Array<["x" | "y" | "z", number, number]> = [
    ["x", minX, maxX],
    ["y", minY, maxY],
    ["z", minZ, maxZ],
  ];

  for (const [axis, min, max] of axes) {
    const originValue = origin[axis];
    const directionValue = direction[axis];
    if (Math.abs(directionValue) < 0.00001) {
      if (originValue < min || originValue > max) {
        return null;
      }
      continue;
    }

    const inv = 1 / directionValue;
    let t1 = (min - originValue) * inv;
    let t2 = (max - originValue) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMax < tMin) {
      return null;
    }
  }

  return tMin >= 0 ? tMin : tMax >= 0 ? tMax : null;
}

function pointInsideBlocker(point: Point3) {
  return MAP1_BLOCKERS.some((blocker) => {
    const [cx, cy, cz] = blocker.center;
    const [sx, sy, sz] = blocker.size;
    return point.x >= cx - sx / 2 + PLAYER_BLOCKER_MARGIN &&
      point.x <= cx + sx / 2 - PLAYER_BLOCKER_MARGIN &&
      point.y >= cy - sy / 2 &&
      point.y <= cy + sy / 2 &&
      point.z >= cz - sz / 2 + PLAYER_BLOCKER_MARGIN &&
      point.z <= cz + sz / 2 - PLAYER_BLOCKER_MARGIN;
  });
}

function findJumpPadIndex(point: Point3) {
  return MAP1_JUMP_PADS.findIndex((pad) =>
    point.x >= pad.minX &&
    point.x <= pad.maxX &&
    point.z >= pad.minZ &&
    point.z <= pad.maxZ &&
    point.y >= pad.y - 0.25 &&
    point.y <= pad.y + JUMP_PAD_DETECTION_MAX_Y
  );
}

function isJumpPadGraceActive(player: MatchPlayerRuntime, nowMs: number) {
  return player.jumpPadGraceUntilMs !== null && player.jumpPadGraceUntilMs > nowMs;
}

function resolveJumpPadActivation(
  player: MatchPlayerRuntime,
  next: Point3,
  grounded: boolean,
): boolean {
  if (grounded) {
    return false;
  }
  const previousPoint = buildPoint(player.pose.x, player.pose.y, player.pose.z);
  return findJumpPadIndex(previousPoint) !== -1 || findJumpPadIndex(next) !== -1;
}

function resolveMaxAllowedY(player: MatchPlayerRuntime, nowMs: number) {
  return isJumpPadGraceActive(player, nowMs) ? JUMP_PAD_WORLD_Y_MAX : DEFAULT_WORLD_Y_MAX;
}

function pointInsidePlayerBounds(point: Point3, maxY: number) {
  return point.x >= MAP1_PLAYER_BOUNDS.minX &&
    point.x <= MAP1_PLAYER_BOUNDS.maxX &&
    point.z >= MAP1_PLAYER_BOUNDS.minZ &&
    point.z <= MAP1_PLAYER_BOUNDS.maxZ &&
    point.y >= WORLD_Y_MIN &&
    point.y <= maxY;
}

function validatePositionStep(
  previous: MatchPlayerPoseState,
  next: Point3,
  nowMs: number,
  options: {
    grounded: boolean;
    jumpPadGraceActive: boolean;
  },
) {
  const dtSeconds = Math.max(0.05, (nowMs - previous.updatedAtMs) / 1000);
  const maxDistance = options.jumpPadGraceActive
    ? MAX_JUMP_PAD_POSITION_STEP_METERS + MAX_JUMP_PAD_SPEED_MPS * dtSeconds
    : options.grounded
    ? MAX_GROUNDED_POSITION_STEP_METERS + MAX_GROUNDED_SPEED_MPS * dtSeconds
    : MAX_AIRBORNE_POSITION_STEP_METERS + MAX_AIRBORNE_SPEED_MPS * dtSeconds;
  const actualDistance = distanceBetween(
    buildPoint(previous.x, previous.y, previous.z),
    next,
  );
  if (actualDistance > maxDistance) {
    throw new HttpError(409, "Movement update rejected as an impossible teleport.");
  }
}

function resolveEyeHeight(crouched: boolean) {
  return crouched ? 1.08 : 1.4;
}

function resolveRightFromYaw(yaw: number): Point3 {
  return {
    x: Math.cos(yaw),
    y: 0,
    z: -Math.sin(yaw),
  };
}

function resolveForwardFromYaw(yaw: number): Point3 {
  return {
    x: -Math.sin(yaw),
    y: 0,
    z: -Math.cos(yaw),
  };
}

function offsetPoint(
  origin: Point3,
  right: Point3,
  forward: Point3,
  side: number,
  up: number,
  front = 0,
): Point3 {
  return {
    x: origin.x + right.x * side + forward.x * front,
    y: origin.y + up,
    z: origin.z + right.z * side + forward.z * front,
  };
}

function resolveStandingHitSpheres(
  origin: Point3,
  right: Point3,
  forward: Point3,
): MatchHitSphere[] {
  return [
    {
      zone: "head",
      center: offsetPoint(origin, right, forward, 0, 1.54, 0.03),
      radius: 0.2,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0, 1.24, 0.05),
      radius: 0.2,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, -0.22, 1.08, 0.04),
      radius: 0.22,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0.22, 1.08, 0.04),
      radius: 0.22,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0, 0.95, 0.03),
      radius: 0.29,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0, 0.72, 0.01),
      radius: 0.24,
    },
    {
      zone: "leg",
      center: offsetPoint(origin, right, forward, -0.12, 0.46, 0),
      radius: 0.21,
    },
    {
      zone: "leg",
      center: offsetPoint(origin, right, forward, 0.12, 0.46, 0),
      radius: 0.21,
    },
  ];
}

function resolveCrouchedHitSpheres(
  origin: Point3,
  right: Point3,
  forward: Point3,
): MatchHitSphere[] {
  return [
    {
      zone: "head",
      center: offsetPoint(origin, right, forward, 0, 1.18, 0.09),
      radius: 0.19,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0, 0.94, 0.08),
      radius: 0.21,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, -0.18, 0.82, 0.05),
      radius: 0.2,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0.18, 0.82, 0.05),
      radius: 0.2,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0, 0.7, 0.04),
      radius: 0.24,
    },
    {
      zone: "body",
      center: offsetPoint(origin, right, forward, 0, 0.52, 0.02),
      radius: 0.21,
    },
    {
      zone: "leg",
      center: offsetPoint(origin, right, forward, -0.1, 0.34, 0),
      radius: 0.18,
    },
    {
      zone: "leg",
      center: offsetPoint(origin, right, forward, 0.1, 0.34, 0),
      radius: 0.18,
    },
  ];
}

function resolveHitSpheres(target: MatchPlayerRuntime): MatchHitSphere[] {
  const origin = buildPoint(target.pose.x, target.pose.y, target.pose.z);
  const bodyYaw = target.pose.bodyYaw;
  const right = resolveRightFromYaw(bodyYaw);
  const forward = resolveForwardFromYaw(bodyYaw);
  return target.pose.crouched
    ? resolveCrouchedHitSpheres(origin, right, forward)
    : resolveStandingHitSpheres(origin, right, forward);
}

function resolveRifleDamage(distance: number, zone: MatchHitZone) {
  if (zone === "head") {
    const oneShotRange = 16;
    const falloffEndRange = 58;
    const t = clamp01((distance - oneShotRange) / (falloffEndRange - oneShotRange));
    return Math.round(125 + (62 - 125) * t);
  }
  if (zone === "leg") {
    return 13;
  }
  return 15;
}

function applyDueTransitions(match: MatchRuntime, nowMs: number) {
  let changed = false;
  const playerStates: MatchPlayerRealtimeStatePayload[] = [];

  for (const player of match.players.values()) {
    if (player.reloadingUntilMs !== null && nowMs >= player.reloadingUntilMs) {
      player.reloadingUntilMs = null;
      player.magAmmo = MATCH_MAX_MAG_AMMO;
      changed = true;
    }

    if (!player.alive && player.respawnAtMs !== null && nowMs >= player.respawnAtMs) {
      player.alive = true;
      player.health = MATCH_MAX_HEALTH;
      player.respawnAtMs = null;
      player.magAmmo = MATCH_MAX_MAG_AMMO;
      player.reloadingUntilMs = null;
      player.lastShotAtMs = null;
      player.jumpPadGraceUntilMs = null;
      player.pose = createSpawnPose(player.slotIndex, nowMs, player.pose.seq);
      changed = true;
      playerStates.push(buildRealtimePlayerState(player));
    }
  }

  return {
    changed,
    playerStates,
  };
}

function createInitialPlayerRuntime(
  userId: string,
  slotIndex: MatchSlotIndex,
  nowMs: number,
): MatchPlayerRuntime {
  return {
    userId,
    slotIndex,
    pose: createSpawnPose(slotIndex, nowMs),
    health: MATCH_MAX_HEALTH,
    alive: true,
    respawnAtMs: null,
    magAmmo: MATCH_MAX_MAG_AMMO,
    reloadingUntilMs: null,
    lastShotAtMs: null,
    jumpPadGraceUntilMs: null,
  };
}

export function createMatchRuntimeManager(): MatchRuntimeManager {
  const matches = new Map<string, MatchRuntime>();

  const getMatchOrThrow = (code: string) => {
    const match = matches.get(code);
    if (!match) {
      throw new HttpError(409, "Match runtime is unavailable for that lobby.");
    }
    return match;
  };

  return {
    createMatch(code, lobby) {
      if (lobby.selectedMapId !== MATCH_MAP_ID) {
        throw new HttpError(409, "Live multiplayer combat is only wired for map1 right now.");
      }

      const nowMs = Date.parse(lobby.activeMatch?.startedAt ?? lobby.createdAt);
      const players = new Map<string, MatchPlayerRuntime>();
      for (const slot of lobby.activeMatch?.slots ?? []) {
        players.set(
          slot.userId,
          createInitialPlayerRuntime(slot.userId, slot.slotIndex, nowMs),
        );
      }

      const match: MatchRuntime = {
        code,
        startedAt: lobby.activeMatch?.startedAt ?? lobby.createdAt,
        mapId: MATCH_MAP_ID,
        players,
      };
      matches.set(code, match);
      return buildMatchState(match);
    },

    loadSerialized(serialized) {
      const match = deserializeMatchRuntime(serialized);
      matches.set(match.code, match);
    },

    serializeCurrent(code) {
      const match = matches.get(code);
      if (!match) {
        return null;
      }
      return serializeMatchRuntime(match);
    },

    destroyMatch(code) {
      matches.delete(code);
    },

    destroyAll() {
      matches.clear();
    },

    getMatchState(code) {
      const match = matches.get(code);
      return match ? buildMatchState(match) : null;
    },

    getPlayerStates(code) {
      const match = matches.get(code);
      if (!match) {
        return [];
      }
      return [...match.players.values()].map(buildRealtimePlayerState);
    },

    handlePlayerState(code, userId, state, now) {
      const match = getMatchOrThrow(code);
      const player = match.players.get(userId);
      if (!player) {
        throw new HttpError(403, "You are not in that live match.");
      }

      const nowMs = now.getTime();
      const transitions = applyDueTransitions(match, nowMs);

      const x = state.x;
      const y = state.y;
      const z = state.z;
      if (
        !isFiniteNumber(x) ||
        !isFiniteNumber(y) ||
        !isFiniteNumber(z) ||
        !isFiniteNumber(state.yaw) ||
        !isFiniteNumber(state.pitch) ||
        !Number.isInteger(state.seq)
      ) {
        throw new HttpError(400, "Realtime player state is invalid.");
      }

      if (player.alive) {
        if (state.seq <= player.pose.seq) {
          return {
            matchState: transitions.changed ? buildMatchState(match) : null,
            playerStates: transitions.playerStates,
            shotFired: null,
          };
        }

        const nextPoint = buildPoint(x, y, z);
        const shouldActivateJumpPadGrace = resolveJumpPadActivation(
          player,
          nextPoint,
          state.grounded,
        );
        const jumpPadGraceActive = shouldActivateJumpPadGrace || isJumpPadGraceActive(player, nowMs);
        if (!pointInsidePlayerBounds(nextPoint, jumpPadGraceActive ? JUMP_PAD_WORLD_Y_MAX : resolveMaxAllowedY(player, nowMs))) {
          return {
            matchState: transitions.changed ? buildMatchState(match) : null,
            playerStates: transitions.playerStates,
            shotFired: null,
          };
        }

        validatePositionStep(player.pose, nextPoint, nowMs, {
          grounded: state.grounded,
          jumpPadGraceActive,
        });
        if (pointInsideBlocker(nextPoint)) {
          throw new HttpError(409, "Movement update rejected inside map geometry.");
        }

        player.pose = {
          slotIndex: player.slotIndex,
          seq: state.seq,
          x,
          y,
          z,
          yaw: normalizeAngleRadians(state.yaw),
          bodyYaw: normalizeAngleRadians(state.bodyYaw),
          pitch: Math.max(-1.5, Math.min(0.85, state.pitch)),
          moving: state.moving,
          sprinting: state.sprinting,
          crouched: state.crouched,
          grounded: state.grounded,
          ads: state.ads,
          animState: state.animState,
          locomotionScale: clamp01(state.locomotionScale / 2) * 2,
          lowerBodyState: state.lowerBodyState,
          lowerBodyLocomotionScale: clamp01(state.lowerBodyLocomotionScale / 2) * 2,
          upperBodyState: state.upperBodyState,
          updatedAtMs: nowMs,
        };
        if (shouldActivateJumpPadGrace) {
          player.jumpPadGraceUntilMs = nowMs + JUMP_PAD_GRACE_MS;
        } else if (
          player.jumpPadGraceUntilMs !== null &&
          (state.grounded || nowMs >= player.jumpPadGraceUntilMs)
        ) {
          player.jumpPadGraceUntilMs = null;
        }
      }

      return {
        matchState: transitions.changed ? buildMatchState(match) : null,
        playerStates: [
          ...transitions.playerStates,
          ...(player.alive ? [buildRealtimePlayerState(player)] : []),
        ],
        shotFired: null,
      };
    },

    handleFire(code, userId, shotId, weaponType, now) {
      const match = getMatchOrThrow(code);
      const shooter = match.players.get(userId);
      if (!shooter) {
        throw new HttpError(403, "You are not in that live match.");
      }

      const nowMs = now.getTime();
      const transitions = applyDueTransitions(match, nowMs);

      if (!shooter.alive) {
        return {
          matchState: transitions.changed ? buildMatchState(match) : null,
          playerStates: transitions.playerStates,
          shotFired: null,
        };
      }
      if (weaponType !== "rifle") {
        throw new HttpError(409, "Only the rifle is enabled in live multiplayer right now.");
      }
      if (shooter.reloadingUntilMs !== null && nowMs < shooter.reloadingUntilMs) {
        return {
          matchState: transitions.changed ? buildMatchState(match) : null,
          playerStates: transitions.playerStates,
          shotFired: null,
        };
      }
      if (shooter.magAmmo <= 0) {
        if (shooter.reloadingUntilMs === null) {
          shooter.reloadingUntilMs = nowMs + MATCH_RELOAD_MS;
          return {
            matchState: buildMatchState(match),
            playerStates: transitions.playerStates,
            shotFired: null,
          };
        }
        return {
          matchState: transitions.changed ? buildMatchState(match) : null,
          playerStates: transitions.playerStates,
          shotFired: null,
        };
      }
      if (
        shooter.lastShotAtMs !== null &&
        nowMs - shooter.lastShotAtMs < MATCH_FIRE_INTERVAL_MS
      ) {
        return {
          matchState: transitions.changed ? buildMatchState(match) : null,
          playerStates: transitions.playerStates,
          shotFired: null,
        };
      }

      shooter.lastShotAtMs = nowMs;
      shooter.magAmmo = Math.max(0, shooter.magAmmo - 1);

      const origin = buildPoint(
        shooter.pose.x,
        shooter.pose.y + resolveEyeHeight(shooter.pose.crouched),
        shooter.pose.z,
      );
      const direction = directionFromYawPitch(shooter.pose.yaw, shooter.pose.pitch);

      let closestHit:
        | {
            target: MatchPlayerRuntime;
            zone: MatchHitZone;
            distance: number;
          }
        | null = null;

      for (const target of match.players.values()) {
        if (target.userId === shooter.userId || !target.alive) {
          continue;
        }

        for (const sphere of resolveHitSpheres(target)) {
          const distance = intersectRaySphere(origin, direction, sphere.center, sphere.radius);
          if (distance === null) {
            continue;
          }

          if (!closestHit || distance < closestHit.distance) {
            closestHit = {
              target,
              zone: sphere.zone,
              distance,
            };
          }
        }
      }

      let hit: ShotFiredPayload["hit"] = null;
      if (closestHit) {
        const blockerDistance = MAP1_BLOCKERS
          .map((blocker) => intersectRayAabb(origin, direction, blocker))
          .filter((distance): distance is number => distance !== null)
          .sort((left, right) => left - right)[0] ?? null;

        if (blockerDistance === null || blockerDistance > closestHit.distance) {
          const damage = resolveRifleDamage(closestHit.distance, closestHit.zone);
          const remainingHealth = Math.max(0, closestHit.target.health - damage);
          closestHit.target.health = remainingHealth;
          const killed = remainingHealth <= 0;
          if (killed) {
            closestHit.target.alive = false;
            closestHit.target.respawnAtMs = nowMs + MATCH_RESPAWN_MS;
            closestHit.target.reloadingUntilMs = null;
            closestHit.target.lastShotAtMs = null;
          }
          hit = {
            userId: closestHit.target.userId,
            zone: closestHit.zone,
            damage,
            remainingHealth,
            killed,
            impactPoint: [
              origin.x + direction.x * closestHit.distance,
              origin.y + direction.y * closestHit.distance,
              origin.z + direction.z * closestHit.distance,
            ],
          };
        }
      }

      if (shooter.magAmmo <= 0 && shooter.reloadingUntilMs === null) {
        shooter.reloadingUntilMs = nowMs + MATCH_RELOAD_MS;
      }

      return {
        matchState: buildMatchState(match),
        playerStates: transitions.playerStates,
        shotFired: {
          userId: shooter.userId,
          shotId,
          origin: [origin.x, origin.y, origin.z],
          direction: [direction.x, direction.y, direction.z],
          hit,
        },
      };
    },

    handleReload(code, userId, now) {
      const match = getMatchOrThrow(code);
      const player = match.players.get(userId);
      if (!player) {
        throw new HttpError(403, "You are not in that live match.");
      }

      const nowMs = now.getTime();
      const transitions = applyDueTransitions(match, nowMs);

      if (!player.alive) {
        return {
          matchState: transitions.changed ? buildMatchState(match) : null,
          playerStates: transitions.playerStates,
          shotFired: null,
        };
      }
      if (player.reloadingUntilMs !== null && nowMs < player.reloadingUntilMs) {
        return {
          matchState: transitions.changed ? buildMatchState(match) : null,
          playerStates: transitions.playerStates,
          shotFired: null,
        };
      }
      if (player.magAmmo >= MATCH_MAX_MAG_AMMO) {
        return {
          matchState: transitions.changed ? buildMatchState(match) : null,
          playerStates: transitions.playerStates,
          shotFired: null,
        };
      }

      player.reloadingUntilMs = nowMs + MATCH_RELOAD_MS;
      return {
        matchState: buildMatchState(match),
        playerStates: transitions.playerStates,
        shotFired: null,
      };
    },
  };
}

export function serializeMatchRuntime(match: MatchRuntime): string {
  return JSON.stringify({
    code: match.code,
    startedAt: match.startedAt,
    mapId: match.mapId,
    players: Object.fromEntries(match.players),
  });
}

export function deserializeMatchRuntime(json: string): MatchRuntime {
  const parsed = JSON.parse(json) as {
    code: string;
    startedAt: string;
    mapId: MatchMapId;
    players: Record<string, MatchPlayerRuntime>;
  };
  return {
    code: parsed.code,
    startedAt: parsed.startedAt,
    mapId: parsed.mapId,
    players: new Map(Object.entries(parsed.players)),
  };
}
