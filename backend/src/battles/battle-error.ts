/**
 * Chain/engine errors are thrown as `CODE: detail` (docs/backend-api.md §7); the
 * battle engine also throws bare codes. Both forms map back to the code so the
 * client can show a localized message instead of a generic BATTLE_ERROR.
 */
export function errorCodeOf(message: string): string {
  const match = /^([A-Z][A-Z0-9_]*)(?::|\s|$)/.exec(message ?? '');
  return match ? match[1] : 'BATTLE_ERROR';
}
