export type PublicUser = {
  id: string;
  username: string;
  createdAt: string;
};

export type AuthContext = PublicUser & {
  sessionId: string;
  tokenHash: string;
};

export type LobbyPlayer = {
  userId: string;
  username: string;
  isHost: boolean;
  isReady: boolean;
  joinedAt: string;
  selectedCharacterId: string;
};

export type MatchSpawnSlot = "host" | "guest";

export type ActiveMatchSlot = {
  userId: string;
  spawnSlot: MatchSpawnSlot;
  selectedCharacterId: string;
};

export type ActiveMatchPayload = {
  startedAt: string;
  slots: ActiveMatchSlot[];
};

export type LobbyStatus = "open" | "in_match";

export type LobbyPayload = {
  code: string;
  status: LobbyStatus;
  hostUserId: string;
  maxPlayers: 2;
  selectedMapId: string;
  createdAt: string;
  expiresAt: string;
  activeMatch: ActiveMatchPayload | null;
  players: LobbyPlayer[];
};

export type MatchEndedReason =
  | "host_disconnected"
  | "player_disconnected"
  | "host_left"
  | "player_left"
  | "host_ended_match"
  | "player_ended_match";

export type MatchMapId = "map1";

export type MatchPlayerStatePayload = {
  userId: string;
  spawnSlot: MatchSpawnSlot;
  health: number;
  alive: boolean;
  respawnAt: string | null;
  magAmmo: number;
  reloadingUntil: string | null;
};

export type MatchStatePayload = {
  startedAt: string;
  mapId: MatchMapId;
  players: MatchPlayerStatePayload[];
};

export type MatchPlayerRealtimeStatePayload = {
  userId: string;
  seq: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  bodyYaw: number;
  pitch: number;
  moving: boolean;
  sprinting: boolean;
  crouched: boolean;
  grounded: boolean;
  ads: boolean;
  animState: string;
  locomotionScale: number;
  lowerBodyState: string | null;
  lowerBodyLocomotionScale: number;
  upperBodyState: string | null;
  alive: boolean;
};

export type MatchHitZone = "head" | "body" | "leg";

export type ShotHitPayload = {
  userId: string;
  zone: MatchHitZone;
  damage: number;
  remainingHealth: number;
  killed: boolean;
  impactPoint: [number, number, number];
};

export type ShotFiredPayload = {
  userId: string;
  shotId: string;
  origin: [number, number, number];
  direction: [number, number, number];
  hit: ShotHitPayload | null;
};
