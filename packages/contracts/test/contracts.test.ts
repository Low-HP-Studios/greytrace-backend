import {
  assignTeams,
  matchEventSchema,
  selectHostCandidate,
  usernameSchema,
} from "@greytrace/contracts";
import { describe, expect, it } from "vitest";

describe("contracts", () => {
  it("rejects invalid usernames", () => {
    expect(() => usernameSchema.parse("bad name")).toThrow();
    expect(() => usernameSchema.parse("ok_name")).not.toThrow();
  });

  it("rejects malformed kill events", () => {
    const result = matchEventSchema.safeParse({
      seq: 1,
      type: "kill",
    });

    expect(result.success).toBe(false);
  });

  it("assigns teams deterministically into a 3v3 split", () => {
    const input = ["a", "b", "c", "d", "e", "f"];
    const first = assignTeams(input, "seed-1");
    const second = assignTeams(input, "seed-1");

    expect(first).toEqual(second);
    expect(first.filter((entry) => entry.team === "alpha")).toHaveLength(3);
    expect(first.filter((entry) => entry.team === "bravo")).toHaveLength(3);
  });

  it("selects the lowest-latency host with tuple tie-breakers", () => {
    const candidates = [
      { userId: "a", joinedAt: 1 },
      { userId: "b", joinedAt: 2 },
      { userId: "c", joinedAt: 3 },
      { userId: "d", joinedAt: 4 },
      { userId: "e", joinedAt: 5 },
      { userId: "f", joinedAt: 6 },
    ] as const;

    const makeProbe = (
      sourceUserId: string,
      targetUserId: string,
      medianRttMs: number,
      maxRttMs: number,
    ) => ({
      sourceUserId,
      targetUserId,
      medianRttMs,
      maxRttMs,
      jitterMs: 2,
      lossPct: 0,
    });

    const probes = [
      makeProbe("a", "b", 20, 25),
      makeProbe("a", "c", 22, 28),
      makeProbe("a", "d", 24, 29),
      makeProbe("a", "e", 26, 31),
      makeProbe("a", "f", 28, 33),

      makeProbe("b", "a", 20, 25),
      makeProbe("b", "c", 22, 55),
      makeProbe("b", "d", 24, 58),
      makeProbe("b", "e", 26, 60),
      makeProbe("b", "f", 28, 63),

      makeProbe("c", "a", 35, 42),
      makeProbe("c", "b", 35, 44),
      makeProbe("c", "d", 37, 45),
      makeProbe("c", "e", 39, 47),
      makeProbe("c", "f", 41, 49),

      makeProbe("d", "a", 45, 52),
      makeProbe("d", "b", 45, 53),
      makeProbe("d", "c", 46, 54),
      makeProbe("d", "e", 48, 55),
      makeProbe("d", "f", 49, 57),

      makeProbe("e", "a", 55, 62),
      makeProbe("e", "b", 55, 63),
      makeProbe("e", "c", 56, 64),
      makeProbe("e", "d", 57, 65),
      makeProbe("e", "f", 58, 66),

      makeProbe("f", "a", 60, 70),
      makeProbe("f", "b", 61, 71),
      makeProbe("f", "c", 62, 72),
      makeProbe("f", "d", 63, 73),
      makeProbe("f", "e", 64, 74),
    ];

    const result = selectHostCandidate({
      candidates,
      probes,
    });

    expect(result.hostUserId).toBe("a");
    expect(result.scores[0]?.userId).toBe("a");
  });
});
