import { ZodError } from "zod";
import { HttpError } from "./errors.js";

export function parseOrThrow<T>(schema: { parse: (input: unknown) => T }, input: unknown) {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new HttpError(400, issue?.message ?? "Invalid request.");
    }
    throw error;
  }
}
