import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, lte } from "drizzle-orm";
import type { AppConfig } from "./config.js";
import { sessions, users } from "./db/schema.js";
import type { AppDatabase } from "./db/client.js";
import type { AuthContext, PublicUser } from "./domain.js";
import { HttpError } from "./errors.js";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_REGEX,
  createId,
  createOpaqueToken,
  hashPassword,
  hashToken,
  normalizeUsername,
  verifyPassword,
} from "./security.js";

type UserRow = {
  id: string;
  username: string;
  createdAt: string;
};

export type AuthGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
  };
}

function toIsoDate(timestamp: number) {
  return new Date(timestamp).toISOString();
}

export function authenticateToken(
  db: AppDatabase,
  config: AppConfig,
  rawToken: string,
): AuthContext {
  clearExpiredSessions(db, config.now().toISOString());

  const trimmedToken = rawToken.trim();
  if (!trimmedToken) {
    throw new HttpError(401, "Authentication is required.");
  }

  const tokenHash = hashToken(trimmedToken);
  const session = db.select({
    sessionId: sessions.id,
    tokenHash: sessions.tokenHash,
    expiresAt: sessions.expiresAt,
    userId: users.id,
    username: users.username,
    createdAt: users.createdAt,
  })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .get();

  if (!session) {
    throw new HttpError(401, "Authentication is required.");
  }

  const now = config.now();
  const nowIso = now.toISOString();
  if (session.expiresAt <= nowIso) {
    db.delete(sessions).where(eq(sessions.id, session.sessionId)).run();
    throw new HttpError(401, "Session expired. Please sign in again.");
  }

  const nextExpiryIso = toIsoDate(now.getTime() + config.sessionTtlMs);
  db.update(sessions)
    .set({
      expiresAt: nextExpiryIso,
      lastUsedAt: nowIso,
    })
    .where(eq(sessions.id, session.sessionId))
    .run();

  return {
    id: session.userId,
    username: session.username,
    createdAt: session.createdAt,
    sessionId: session.sessionId,
    tokenHash: session.tokenHash,
  } satisfies AuthContext;
}

function validateCredentials(username: string, password: string) {
  if (!USERNAME_REGEX.test(username)) {
    throw new HttpError(
      400,
      "Username must be 3-20 characters and use only letters, numbers, or underscores.",
    );
  }

  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, "Password must be between 8 and 72 characters.");
  }
}

function createSession(db: AppDatabase, config: AppConfig, user: UserRow) {
  const now = config.now();
  const nowIso = now.toISOString();
  const expiresAt = toIsoDate(now.getTime() + config.sessionTtlMs);
  const rawToken = createOpaqueToken();

  db.insert(sessions).values({
    id: createId(),
    userId: user.id,
    tokenHash: hashToken(rawToken),
    createdAt: nowIso,
    expiresAt,
    lastUsedAt: nowIso,
  }).run();

  return {
    token: rawToken,
    user: toPublicUser(user),
  };
}

export function clearExpiredSessions(db: AppDatabase, nowIso: string) {
  db.delete(sessions).where(lte(sessions.expiresAt, nowIso)).run();
}

export async function signUp(
  db: AppDatabase,
  config: AppConfig,
  username: string,
  password: string,
) {
  const trimmedUsername = username.trim();
  const usernameNormalized = normalizeUsername(trimmedUsername);

  validateCredentials(trimmedUsername, password);

  const existingUser = db.select({ id: users.id })
    .from(users)
    .where(eq(users.usernameNormalized, usernameNormalized))
    .get();

  if (existingUser) {
    throw new HttpError(409, "That username is already taken.");
  }

  const nowIso = config.now().toISOString();
  const passwordHash = await hashPassword(password);
  const user = {
    id: createId(),
    username: trimmedUsername,
    usernameNormalized,
    passwordHash,
    createdAt: nowIso,
  };

  try {
    db.insert(users).values(user).run();
  } catch {
    throw new HttpError(409, "That username is already taken.");
  }

  return createSession(db, config, user);
}

export async function signIn(
  db: AppDatabase,
  config: AppConfig,
  username: string,
  password: string,
) {
  const trimmedUsername = username.trim();
  const usernameNormalized = normalizeUsername(trimmedUsername);

  validateCredentials(trimmedUsername, password);

  const user = db.select({
    id: users.id,
    username: users.username,
    passwordHash: users.passwordHash,
    createdAt: users.createdAt,
  })
    .from(users)
    .where(eq(users.usernameNormalized, usernameNormalized))
    .get();

  if (!user) {
    throw new HttpError(401, "Invalid username or password.");
  }

  const passwordMatches = await verifyPassword(user.passwordHash, password);
  if (!passwordMatches) {
    throw new HttpError(401, "Invalid username or password.");
  }

  return createSession(db, config, user);
}

export function createAuthGuard(
  db: AppDatabase,
  config: AppConfig,
): AuthGuard {
  return async (request) => {
    const authorizationHeader = request.headers.authorization;
    if (!authorizationHeader?.startsWith("Bearer ")) {
      throw new HttpError(401, "Authentication is required.");
    }

    request.auth = authenticateToken(
      db,
      config,
      authorizationHeader.slice("Bearer ".length),
    );
  };
}

export function getSessionUser(auth: AuthContext): PublicUser {
  return {
    id: auth.id,
    username: auth.username,
    createdAt: auth.createdAt,
  };
}

export function logoutSession(db: AppDatabase, auth: AuthContext) {
  db.delete(sessions)
    .where(and(eq(sessions.id, auth.sessionId), eq(sessions.tokenHash, auth.tokenHash)))
    .run();
}
