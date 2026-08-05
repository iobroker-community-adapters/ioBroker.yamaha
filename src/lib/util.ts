/**
 * The message of an unknown thrown value — `Error.message` when it is an Error, else
 * its string form. One helper for the `e instanceof Error ? e.message : String(e)`
 * idiom the transports would otherwise repeat in every catch.
 *
 * @param e the caught value
 * @returns a human-readable message
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
