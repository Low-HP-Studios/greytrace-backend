import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("cleanup expired sessions and lobbies", { hours: 1 }, internal.cleanup.runCleanup, {});

export default crons;
