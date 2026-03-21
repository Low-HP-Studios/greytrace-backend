import {
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";

export const query = queryGeneric;
export const mutation = mutationGeneric;
export const internalMutation = internalMutationGeneric;

export type QueryCtx = GenericQueryCtx<any>;
export type MutationCtx = GenericMutationCtx<any>;
