/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as cleanup from "../cleanup.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as domain from "../domain.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_httpError from "../lib/httpError.js";
import type * as lib_roomCode from "../lib/roomCode.js";
import type * as lib_validation from "../lib/validation.js";
import type * as lobbies from "../lobbies.js";
import type * as match from "../match.js";
import type * as matchRuntimeEngine from "../matchRuntimeEngine.js";
import type * as presence from "../presence.js";
import type * as sessionHelpers from "../sessionHelpers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  cleanup: typeof cleanup;
  constants: typeof constants;
  crons: typeof crons;
  domain: typeof domain;
  "lib/crypto": typeof lib_crypto;
  "lib/httpError": typeof lib_httpError;
  "lib/roomCode": typeof lib_roomCode;
  "lib/validation": typeof lib_validation;
  lobbies: typeof lobbies;
  match: typeof match;
  matchRuntimeEngine: typeof matchRuntimeEngine;
  presence: typeof presence;
  sessionHelpers: typeof sessionHelpers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
