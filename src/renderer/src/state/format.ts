const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const clock = `${pad(minutes)}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

export function formatClock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function initialOf(name: string): string {
  const first = name.trim().charAt(0);
  return first === '' ? '#' : first.toUpperCase();
}

/** Translates a key that may come from outside the dictionary, falling back instead of throwing. */
export function textOrFallback(t: (key: string) => string, key: string, fallbackKey: string): string {
  try {
    return t(key);
  } catch {
    return t(fallbackKey);
  }
}
