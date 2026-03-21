import { turnConfigSchema, type TurnConfig } from "@greytrace/contracts";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  CORS_ORIGIN: z.string().url(),
  CONVEX_URL: z.string().url(),
  CONVEX_SITE_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url().optional(),
  TURN_URLS: z.string().min(1),
  TURN_USERNAME: z.string().min(1),
  TURN_CREDENTIAL: z.string().min(1),
});

export type AppConfig = z.infer<typeof envSchema> & {
  turn: TurnConfig;
};

const parseTurnConfig = (
  turnUrls: string,
  username: string,
  credential: string,
) =>
  turnConfigSchema.parse({
    iceServers: [
      {
        urls: turnUrls
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        username,
        credential,
      },
    ],
  });

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.parse(source);
  return {
    ...parsed,
    BETTER_AUTH_URL: parsed.BETTER_AUTH_URL ?? parsed.CONVEX_SITE_URL,
    turn: parseTurnConfig(
      parsed.TURN_URLS,
      parsed.TURN_USERNAME,
      parsed.TURN_CREDENTIAL,
    ),
  };
};
