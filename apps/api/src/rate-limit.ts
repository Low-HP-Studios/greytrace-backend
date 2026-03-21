import type { MiddlewareHandler } from "hono";

type Bucket = {
  count: number;
  resetAt: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  consume(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const current = this.buckets.get(key);

    if (!current || current.resetAt <= now) {
      const nextBucket = {
        count: 1,
        resetAt: now + windowMs,
      } satisfies Bucket;
      this.buckets.set(key, nextBucket);
      return {
        allowed: true,
        remaining: Math.max(limit - 1, 0),
        retryAfterMs: windowMs,
      };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: current.resetAt - now,
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: Math.max(limit - current.count, 0),
      retryAfterMs: current.resetAt - now,
    };
  }
}

const resolveClientKey = (request: Request) => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  return request.headers.get("cf-connecting-ip") ?? "unknown";
};

export const createRateLimitMiddleware = (options: {
  limiter: InMemoryRateLimiter;
  limit: number;
  windowMs: number;
  namespace: string;
}): MiddlewareHandler => {
  return async (context, next) => {
    const key = `${options.namespace}:${resolveClientKey(context.req.raw)}`;
    const result = options.limiter.consume(
      key,
      options.limit,
      options.windowMs,
    );

    context.header("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      context.header(
        "Retry-After",
        String(Math.ceil(result.retryAfterMs / 1_000)),
      );
      return context.json(
        {
          error: "rate_limited",
          retryAfterMs: result.retryAfterMs,
        },
        429,
      );
    }

    await next();
  };
};
