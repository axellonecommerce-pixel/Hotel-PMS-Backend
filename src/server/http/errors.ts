/**
 * Messages shown to staff come only from InnSeva's own checks ("This payment
 * was already deposited…"), never from the database. A Postgres error (it has
 * a severity and an SQLSTATE code, and may name tables or constraints) is
 * never shown; the route rethrows it and the server answers with a generic
 * error while the details stay in the server logs.
 */
export function isDatabaseError(error: unknown) {
  return typeof error === "object" && error !== null && "severity" in error && "code" in error && typeof (error as { code: unknown }).code === "string";
}

/** True when the error is one of our own messages matching `pattern`. */
export function isUserMessage(error: unknown, pattern: RegExp): error is Error {
  return error instanceof Error && !isDatabaseError(error) && pattern.test(error.message);
}
