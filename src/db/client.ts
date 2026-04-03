import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export type SqliteConnection = Database.Database;

function initializeDatabase(sqlite: SqliteConnection) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_normalized TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lobbies (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      host_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open',
      max_players INTEGER NOT NULL,
      selected_map_id TEXT NOT NULL DEFAULT 'range',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      match_started_at TEXT
    );

    CREATE TABLE IF NOT EXISTS lobby_members (
      lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_ready INTEGER NOT NULL DEFAULT 0,
      selected_character_id TEXT NOT NULL DEFAULT 'stylish-man',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (lobby_id, user_id)
    );
  `);

  const lobbyColumns = sqlite.prepare("PRAGMA table_info(lobbies)").all() as Array<{
    name: string;
  }>;
  const lobbyColumnNames = new Set(lobbyColumns.map((column) => column.name));
  if (!lobbyColumnNames.has("selected_map_id")) {
    sqlite.exec("ALTER TABLE lobbies ADD COLUMN selected_map_id TEXT NOT NULL DEFAULT 'range';");
  }
  if (!lobbyColumnNames.has("match_started_at")) {
    sqlite.exec("ALTER TABLE lobbies ADD COLUMN match_started_at TEXT;");
  }

  const lobbyMemberColumns = sqlite.prepare("PRAGMA table_info(lobby_members)").all() as Array<{
    name: string;
  }>;
  const lobbyMemberColumnNames = new Set(lobbyMemberColumns.map((column) => column.name));
  if (!lobbyMemberColumnNames.has("selected_character_id")) {
    sqlite.exec(
      "ALTER TABLE lobby_members ADD COLUMN selected_character_id TEXT NOT NULL DEFAULT 'stylish-man';",
    );
  }
}

export function createDatabase(filePath: string) {
  const sqlite = new Database(filePath);
  sqlite.pragma("foreign_keys = ON");

  if (filePath !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }

  initializeDatabase(sqlite);

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
  };
}
