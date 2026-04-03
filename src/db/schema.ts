import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  usernameNormalized: text("username_normalized").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
});

export const lobbies = sqliteTable("lobbies", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  hostUserId: text("host_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("open"),
  maxPlayers: integer("max_players").notNull(),
  selectedMapId: text("selected_map_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  matchStartedAt: text("match_started_at"),
});

export const lobbyMembers = sqliteTable(
  "lobby_members",
  {
    lobbyId: text("lobby_id")
      .notNull()
      .references(() => lobbies.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isReady: integer("is_ready", { mode: "boolean" }).notNull().default(false),
    selectedCharacterId: text("selected_character_id").notNull(),
    joinedAt: text("joined_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lobbyId, table.userId] }),
  }),
);
