import { z } from "zod";

export const MAX_LOBBY_PLAYERS = 6;
export const TEAM_SIZE = 3;
export const PROBE_WINDOW_MS = 5_000;
export const MAX_EVENT_BATCH_SIZE = 50;

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[A-Za-z0-9_]+$/);

export const passwordSchema = z.string().min(8).max(72);

export const userIdSchema = z.string().min(1);
export const matchIdSchema = z.string().min(1);
export const lobbyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/);

export const connectionStateSchema = z.enum(["connected", "disconnected"]);
export const teamSchema = z.enum(["alpha", "bravo"]);
export const lobbyStatusSchema = z.enum([
  "forming",
  "probing",
  "match_live",
  "closed",
]);
export const matchStatusSchema = z.enum([
  "pending",
  "live",
  "aborted",
  "completed",
]);

export const createLobbyInputSchema = z.object({
  mapId: z.string().trim().min(1).max(64).default("range"),
});

export const readyInputSchema = z.object({
  ready: z.boolean(),
});

export const probeMetricsSchema = z.object({
  medianRttMs: z.number().finite().nonnegative().max(1_000),
  maxRttMs: z.number().finite().nonnegative().max(2_000),
  jitterMs: z.number().finite().nonnegative().max(500),
  lossPct: z.number().finite().min(0).max(100),
});

export const reportProbeInputSchema = probeMetricsSchema.extend({
  targetUserId: userIdSchema,
});

export const matchEventTypeSchema = z.enum([
  "kill",
  "death",
  "assist",
  "roundStart",
  "roundEnd",
  "hostSelected",
  "system",
]);

const baseMatchEventSchema = z.object({
  seq: z.number().int().positive(),
  type: matchEventTypeSchema,
  actorUserId: userIdSchema.optional(),
  victimUserId: userIdSchema.optional(),
  weaponId: z.string().trim().min(1).max(64).optional(),
  headshot: z.boolean().optional(),
  occurredAtMs: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const matchEventSchema = baseMatchEventSchema.superRefine((event, ctx) => {
  if (event.type === "kill") {
    if (!event.actorUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Kill events require actorUserId",
        path: ["actorUserId"],
      });
    }
    if (!event.victimUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Kill events require victimUserId",
        path: ["victimUserId"],
      });
    }
    if (!event.weaponId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Kill events require weaponId",
        path: ["weaponId"],
      });
    }
  }

  if (event.type === "assist") {
    if (!event.actorUserId || !event.victimUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Assist events require actorUserId and victimUserId",
      });
    }
  }

  if (event.type === "hostSelected" && !event.actorUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "hostSelected events require actorUserId",
      path: ["actorUserId"],
    });
  }

  if (event.type === "system" && !event.metadata?.message) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "system events require metadata.message",
      path: ["metadata", "message"],
    });
  }
});

export const appendMatchEventsInputSchema = z.object({
  events: z.array(matchEventSchema).min(1).max(MAX_EVENT_BATCH_SIZE),
});

export const signalingMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("identify"),
    lobbyCode: lobbyCodeSchema,
  }),
  z.object({
    type: z.literal("offer"),
    lobbyCode: lobbyCodeSchema,
    targetUserId: userIdSchema,
    sdp: z.string().min(1),
  }),
  z.object({
    type: z.literal("answer"),
    lobbyCode: lobbyCodeSchema,
    targetUserId: userIdSchema,
    sdp: z.string().min(1),
  }),
  z.object({
    type: z.literal("ice-candidate"),
    lobbyCode: lobbyCodeSchema,
    targetUserId: userIdSchema,
    candidate: z.unknown(),
  }),
  z.object({
    type: z.literal("probe-start"),
    lobbyCode: lobbyCodeSchema,
    targetUserId: userIdSchema,
  }),
  z.object({
    type: z.literal("probe-complete"),
    lobbyCode: lobbyCodeSchema,
    targetUserId: userIdSchema,
    metrics: probeMetricsSchema,
  }),
  z.object({
    type: z.literal("peer-left"),
    lobbyCode: lobbyCodeSchema,
    userId: userIdSchema,
  }),
]);

export const authClaimsSchema = z.object({
  sub: userIdSchema,
  sessionId: z.string().min(1),
  username: z.string().optional(),
  displayUsername: z.string().optional(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  iss: z.string().url(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
});

export const currentUserSchema = z.object({
  id: userIdSchema,
  authUserId: userIdSchema,
  username: usernameSchema,
  displayName: z.string().min(1).max(64),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
});

export const lobbyMemberSchema = z.object({
  userId: userIdSchema,
  username: usernameSchema,
  displayName: z.string().min(1).max(64),
  slot: z.number().int().min(0).max(MAX_LOBBY_PLAYERS - 1),
  ready: z.boolean(),
  team: teamSchema.nullable(),
  joinedAt: z.number().int().nonnegative(),
  connectionState: connectionStateSchema,
});

export const probeSummarySchema = z.object({
  expectedReports: z.number().int().nonnegative(),
  receivedReports: z.number().int().nonnegative(),
  deadlineAt: z.number().int().nonnegative().nullable(),
});

export const lobbyViewSchema = z.object({
  id: z.string().min(1),
  code: lobbyCodeSchema,
  status: lobbyStatusSchema,
  mode: z.literal("tdm"),
  mapId: z.string().min(1),
  maxPlayers: z.literal(MAX_LOBBY_PLAYERS),
  ownerUserId: userIdSchema,
  hostUserId: userIdSchema.nullable(),
  matchId: matchIdSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  members: z.array(lobbyMemberSchema),
  probeSummary: probeSummarySchema,
});

export const matchPlayerSchema = z.object({
  userId: userIdSchema,
  username: usernameSchema,
  displayName: z.string().min(1).max(64),
  team: teamSchema,
});

export const matchEventViewSchema = matchEventSchema.extend({
  serverTimestamp: z.number().int().nonnegative(),
});

export const matchViewSchema = z.object({
  id: matchIdSchema,
  lobbyId: z.string().min(1),
  hostUserId: userIdSchema,
  status: matchStatusSchema,
  scoreAlpha: z.number().int().nonnegative(),
  scoreBravo: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  lastEventSeq: z.number().int().nonnegative(),
  players: z.array(matchPlayerSchema),
  events: z.array(matchEventViewSchema),
});

export const iceServerSchema = z.object({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().min(1).optional(),
  credential: z.string().min(1).optional(),
});

export const turnConfigSchema = z.object({
  iceServers: z.array(iceServerSchema).min(1),
});

export type AuthClaims = z.infer<typeof authClaimsSchema>;
export type AppendMatchEventsInput = z.infer<typeof appendMatchEventsInputSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;
export type CreateLobbyInput = z.infer<typeof createLobbyInputSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type HostProbeMetrics = z.infer<typeof probeMetricsSchema>;
export type LobbyMember = z.infer<typeof lobbyMemberSchema>;
export type LobbyStatus = z.infer<typeof lobbyStatusSchema>;
export type LobbyView = z.infer<typeof lobbyViewSchema>;
export type MatchEvent = z.infer<typeof matchEventSchema>;
export type MatchView = z.infer<typeof matchViewSchema>;
export type ReadyInput = z.infer<typeof readyInputSchema>;
export type ReportProbeInput = z.infer<typeof reportProbeInputSchema>;
export type SignalingMessage = z.infer<typeof signalingMessageSchema>;
export type Team = z.infer<typeof teamSchema>;
export type TurnConfig = z.infer<typeof turnConfigSchema>;

export type HostCandidateInput = {
  userId: string;
  joinedAt: number;
};

export type ProbeResultInput = HostProbeMetrics & {
  sourceUserId: string;
  targetUserId: string;
};

export type HostCandidateScore = HostCandidateInput & {
  medianRttMs: number;
  maxRttMs: number;
  lossPct: number;
  jitterMs: number;
};

export const normalizeLobbyCode = (code: string) => code.trim().toUpperCase();

export const expectedProbeReportCount = (memberCount: number) =>
  memberCount * Math.max(memberCount - 1, 0);

export const average = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

export const median = (values: number[]) => {
  if (values.length === 0) {
    throw new Error("Median requires at least one value");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint]!;
  }
  return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
};

const fnv1a32 = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const assignTeams = (
  playerIds: readonly string[],
  seed: string,
): Array<{ userId: string; team: Team }> => {
  if (playerIds.length !== MAX_LOBBY_PLAYERS) {
    throw new Error(`Expected ${MAX_LOBBY_PLAYERS} players for team assignment`);
  }

  const orderedPlayers = [...playerIds].sort((left, right) => {
    const leftRank = fnv1a32(`${seed}:${left}`);
    const rightRank = fnv1a32(`${seed}:${right}`);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });

  return orderedPlayers.map((userId, index) => ({
    userId,
    team: index < TEAM_SIZE ? "alpha" : "bravo",
  }));
};

const compareHostScores = (
  left: HostCandidateScore,
  right: HostCandidateScore,
) => {
  if (left.medianRttMs !== right.medianRttMs) {
    return left.medianRttMs - right.medianRttMs;
  }
  if (left.maxRttMs !== right.maxRttMs) {
    return left.maxRttMs - right.maxRttMs;
  }
  if (left.lossPct !== right.lossPct) {
    return left.lossPct - right.lossPct;
  }
  if (left.jitterMs !== right.jitterMs) {
    return left.jitterMs - right.jitterMs;
  }
  if (left.joinedAt !== right.joinedAt) {
    return left.joinedAt - right.joinedAt;
  }
  return left.userId.localeCompare(right.userId);
};

export const selectHostCandidate = (args: {
  candidates: readonly HostCandidateInput[];
  probes: readonly ProbeResultInput[];
}) => {
  const { candidates, probes } = args;
  if (candidates.length !== MAX_LOBBY_PLAYERS) {
    throw new Error(`Host selection expects ${MAX_LOBBY_PLAYERS} candidates`);
  }

  const scores = candidates.map<HostCandidateScore>((candidate) => {
    const candidateProbes = probes.filter(
      (probe) => probe.sourceUserId === candidate.userId,
    );

    if (candidateProbes.length !== MAX_LOBBY_PLAYERS - 1) {
      throw new Error(
        `Missing probe results for candidate ${candidate.userId}`,
      );
    }

    return {
      userId: candidate.userId,
      joinedAt: candidate.joinedAt,
      medianRttMs: median(candidateProbes.map((probe) => probe.medianRttMs)),
      maxRttMs: Math.max(...candidateProbes.map((probe) => probe.maxRttMs)),
      lossPct: average(candidateProbes.map((probe) => probe.lossPct)),
      jitterMs: average(candidateProbes.map((probe) => probe.jitterMs)),
    };
  });

  scores.sort(compareHostScores);
  const host = scores[0];
  if (!host) {
    throw new Error("No host candidate was available");
  }

  return {
    hostUserId: host.userId,
    scores,
  };
};
