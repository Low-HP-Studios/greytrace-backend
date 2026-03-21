import { authClaimsSchema, type AuthClaims } from "@greytrace/contracts";
import { createRemoteJWKSet, jwtVerify } from "jose";

export class ConvexJwtVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly convexSiteUrl: string) {
    this.jwks = createRemoteJWKSet(
      new URL("/api/auth/convex/jwks", convexSiteUrl),
    );
  }

  async verify(token: string): Promise<AuthClaims> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.convexSiteUrl,
      audience: "convex",
    });

    return authClaimsSchema.parse(payload);
  }
}

export const extractBearerToken = (headerValue?: string | null) => {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
};
