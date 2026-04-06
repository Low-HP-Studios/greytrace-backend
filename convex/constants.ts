const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const SESSION_TTL_MS = 30 * DAY_MS;
export const LOBBY_TTL_MS = 6 * HOUR_MS;
export const PRESENCE_TTL_MS = 10_000;
export const MAX_PLAYERS = 2 as const;
