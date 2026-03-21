import type {
  AppendMatchEventsInput,
  AuthClaims,
  ConnectionState,
  CreateLobbyInput,
  CurrentUser,
  LobbyView,
  MatchView,
  ReadyInput,
  ReportProbeInput,
} from "@greytrace/contracts";

export type AuthSession = {
  token: string;
  claims: AuthClaims;
};

export interface BackendService {
  ensureCurrentUser(token: string): Promise<CurrentUser>;
  createLobby(token: string, input: CreateLobbyInput): Promise<LobbyView>;
  joinLobby(token: string, code: string): Promise<LobbyView>;
  leaveLobby(token: string, code: string): Promise<LobbyView>;
  setReady(token: string, code: string, input: ReadyInput): Promise<LobbyView>;
  startProbe(token: string, code: string): Promise<LobbyView>;
  reportProbe(
    token: string,
    code: string,
    input: ReportProbeInput,
  ): Promise<LobbyView>;
  getLobbyView(token: string, code: string): Promise<LobbyView>;
  startMatch(token: string, code: string): Promise<MatchView>;
  getMatchView(token: string, matchId: string): Promise<MatchView>;
  appendMatchEvents(
    token: string,
    matchId: string,
    input: AppendMatchEventsInput,
  ): Promise<MatchView>;
  markPresence(
    token: string,
    input: {
      lobbyCode?: string;
      connectionState?: ConnectionState;
    },
  ): Promise<CurrentUser>;
}
