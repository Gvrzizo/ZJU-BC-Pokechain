/** UTC calendar date (`yyyy-mm-dd`) for daily caps and counters; deterministic. */
export function utcDate(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
