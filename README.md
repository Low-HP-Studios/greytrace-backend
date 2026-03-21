# Greytrace Backend

Backend scaffold for the Greytrace FPS prototype.

## Stack

- `Node.js` + `Hono` for HTTP APIs and WebSocket signaling
- `Convex` for lobby, match, score, and event state
- `Better Auth` for username/password auth, with bearer-based token exchange
- `TypeScript`, `ESLint`, `Prettier`, `Vitest`
- shared `Zod` contracts in `packages/contracts`

## Layout

- `apps/api` - public HTTP API, auth proxy, and signaling WebSocket
- `packages/contracts` - shared schemas and deterministic domain helpers
- `convex` - Convex schema and mutations/queries for lobbies and matches

## Important V1 Decisions

- Convex handles control-plane state, not frame-by-frame shooter traffic.
- Live match packets are expected to go over WebRTC data channels.
- The backend elects a host from pairwise probe results.
- No host migration in v1. If the host drops, the match is aborted and the lobby resets. Charming, but honest.

## Auth Flow

1. `POST /api/auth/sign-up/username`
2. `POST /api/auth/sign-in/username`
3. `GET /api/auth/convex/token`
4. Use the returned Convex JWT as `Authorization: Bearer <token>` for:
   - Hono endpoints
   - Convex client subscriptions and mutations

The username signup route wraps Better Auth email signup with a synthetic internal email so the client only needs username + password.

## Scripts

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm dev:api`
- `pnpm dev:convex`

## Environment

Copy `.env.example` and set:

- `CONVEX_URL`
- `CONVEX_SITE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Production defaults assume North America and `US East`.
