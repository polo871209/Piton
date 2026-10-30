export const WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function localParts(timestamp: number, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

export function formatLocal(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

export function zonedTime(wallClock: number, timezone: string) {
  const offsetAt = (at: number) => {
    const p = localParts(at, timezone);
    const minute = Math.floor(at / 60_000) * 60_000;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - minute;
  };
  const instant = wallClock - offsetAt(wallClock - offsetAt(wallClock));
  const skippedByClockChange = wallClock - (instant + offsetAt(instant));
  return instant + Math.max(0, skippedByClockChange);
}
