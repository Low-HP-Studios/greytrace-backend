import "fastify";
import type { AuthContext } from "./domain.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}
