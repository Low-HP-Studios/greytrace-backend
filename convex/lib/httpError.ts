// DEPRECATED: greytrace-backend is retired; do not use.

import { ConvexError } from "convex/values";

export type HttpErrorData = {
  statusCode: number;
  message: string;
};

export class HttpError extends ConvexError<HttpErrorData> {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super({
      statusCode,
      message,
    });
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.message = message;
  }
}
