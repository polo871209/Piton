import { GrammyError, HttpError } from "grammy/web";

export function errorText(error: unknown): string {
  if (error instanceof GrammyError) {
    return `${error.error_code} ${error.description}`;
  }
  if (error instanceof HttpError) {
    return `${error.message}: ${errorText(error.error)}`;
  }
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined
    ? error.message
    : `${error.message}: ${errorText(error.cause)}`;
}
