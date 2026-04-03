import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type AppConfig = {
  host: string;
  port: number;
  dbFilePath: string;
  sessionTtlMs: number;
  lobbyTtlMs: number;
  corsOrigins: string[];
  now: () => Date;
};

function parseInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveDefaultDbFilePath() {
  if (process.env.GREYTRACE_DB_FILE) {
    return process.env.GREYTRACE_DB_FILE;
  }

  if (process.env.NODE_ENV === "production") {
    return path.join(os.homedir(), ".greytrace-backend", "greytrace.sqlite");
  }

  return path.join(process.cwd(), "data", "greytrace.sqlite");
}

function ensureDbDirectory(dbFilePath: string) {
  if (dbFilePath === ":memory:") {
    return;
  }

  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
}

function resolveCorsOrigins() {
  if (process.env.GREYTRACE_CORS_ORIGINS) {
    return process.env.GREYTRACE_CORS_ORIGINS
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  return ["http://localhost:1420", "app://game"];
}

export function resolveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dbFilePath = overrides.dbFilePath ?? resolveDefaultDbFilePath();
  ensureDbDirectory(dbFilePath);

  return {
    host: overrides.host ?? process.env.HOST ?? "0.0.0.0",
    port: overrides.port ?? parseInteger(process.env.PORT, 8787),
    dbFilePath,
    sessionTtlMs:
      overrides.sessionTtlMs ?? parseInteger(process.env.GREYTRACE_SESSION_TTL_MS, 30 * DAY_MS),
    lobbyTtlMs:
      overrides.lobbyTtlMs ?? parseInteger(process.env.GREYTRACE_LOBBY_TTL_MS, 6 * HOUR_MS),
    corsOrigins: overrides.corsOrigins ?? resolveCorsOrigins(),
    now: overrides.now ?? (() => new Date()),
  };
}
