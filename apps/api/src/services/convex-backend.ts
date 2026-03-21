import {
  appendMatchEventsInputSchema,
  createLobbyInputSchema,
  currentUserSchema,
  lobbyViewSchema,
  matchViewSchema,
  readyInputSchema,
  reportProbeInputSchema,
  type AppendMatchEventsInput,
  type ConnectionState,
  type CreateLobbyInput,
  type ReadyInput,
  type ReportProbeInput,
} from "@greytrace/contracts";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { BackendService } from "../types";

const asQuery = (name: string) => name as unknown as FunctionReference<"query">;
const asMutation = (name: string) =>
  name as unknown as FunctionReference<"mutation">;

const convexFunction = {
  query: {
    currentUser: asQuery("users:getCurrentUser"),
    lobbyView: asQuery("lobbies:getLobbyView"),
    matchView: asQuery("matches:getMatchView"),
  },
  mutation: {
    ensureCurrentUser: asMutation("users:ensureCurrentUserProfile"),
    createLobby: asMutation("lobbies:createLobby"),
    joinLobby: asMutation("lobbies:joinLobby"),
    leaveLobby: asMutation("lobbies:leaveLobby"),
    setReady: asMutation("lobbies:setReady"),
    startProbe: asMutation("lobbies:startProbe"),
    storeProbe: asMutation("lobbies:storeProbeResult"),
    selectHost: asMutation("lobbies:selectHost"),
    upsertPresence: asMutation("lobbies:upsertPresence"),
    createMatch: asMutation("matches:createMatch"),
    appendMatchEvents: asMutation("matches:appendMatchEvents"),
  },
} as const;

export class ConvexBackendService implements BackendService {
  constructor(private readonly convexUrl: string) {}

  private client(token: string) {
    return new ConvexHttpClient(this.convexUrl, {
      auth: token,
      logger: false,
    });
  }

  async ensureCurrentUser(token: string) {
    const client = this.client(token);
    await client.mutation(convexFunction.mutation.ensureCurrentUser, {});
    return currentUserSchema.parse(
      await client.query(convexFunction.query.currentUser, {}),
    );
  }

  async createLobby(token: string, input: CreateLobbyInput) {
    const client = this.client(token);
    return lobbyViewSchema.parse(
      await client.mutation(
        convexFunction.mutation.createLobby,
        createLobbyInputSchema.parse(input),
      ),
    );
  }

  async joinLobby(token: string, code: string) {
    const client = this.client(token);
    return lobbyViewSchema.parse(
      await client.mutation(convexFunction.mutation.joinLobby, { code }),
    );
  }

  async leaveLobby(token: string, code: string) {
    const client = this.client(token);
    return lobbyViewSchema.parse(
      await client.mutation(convexFunction.mutation.leaveLobby, { code }),
    );
  }

  async setReady(token: string, code: string, input: ReadyInput) {
    const client = this.client(token);
    return lobbyViewSchema.parse(
      await client.mutation(convexFunction.mutation.setReady, {
        code,
        ...readyInputSchema.parse(input),
      }),
    );
  }

  async startProbe(token: string, code: string) {
    const client = this.client(token);
    return lobbyViewSchema.parse(
      await client.mutation(convexFunction.mutation.startProbe, { code }),
    );
  }

  async reportProbe(token: string, code: string, input: ReportProbeInput) {
    const client = this.client(token);
    return lobbyViewSchema.parse(
      await client.mutation(convexFunction.mutation.storeProbe, {
        code,
        ...reportProbeInputSchema.parse(input),
      }),
    );
  }

  async getLobbyView(token: string, code: string) {
    const client = this.client(token);
    return lobbyViewSchema.parse(
      await client.query(convexFunction.query.lobbyView, { code }),
    );
  }

  async startMatch(token: string, code: string) {
    const client = this.client(token);
    const lobby = await this.getLobbyView(token, code);
    if (!lobby.hostUserId) {
      await client.mutation(convexFunction.mutation.selectHost, { code });
    }

    return matchViewSchema.parse(
      await client.mutation(convexFunction.mutation.createMatch, { code }),
    );
  }

  async getMatchView(token: string, matchId: string) {
    const client = this.client(token);
    return matchViewSchema.parse(
      await client.query(convexFunction.query.matchView, { matchId }),
    );
  }

  async appendMatchEvents(
    token: string,
    matchId: string,
    input: AppendMatchEventsInput,
  ) {
    const client = this.client(token);
    return matchViewSchema.parse(
      await client.mutation(convexFunction.mutation.appendMatchEvents, {
        matchId,
        events: appendMatchEventsInputSchema.parse(input).events,
      }),
    );
  }

  async markPresence(
    token: string,
    input: {
      lobbyCode?: string;
      connectionState?: ConnectionState;
    },
  ) {
    const client = this.client(token);
    return currentUserSchema.parse(
      await client.mutation(convexFunction.mutation.upsertPresence, input),
    );
  }
}
