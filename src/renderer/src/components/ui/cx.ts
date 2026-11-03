export function cx(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
