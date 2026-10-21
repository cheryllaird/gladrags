/**
 * Day and month boundaries in a given IANA time zone (UK time for the caps),
 * returned as UTC Date objects for database queries. Handles BST.
 */

interface ZonedDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far ahead of UTC the zone is at this instant, in ms. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight on the given local date. */
function zonedMidnight({ year, month, day }: ZonedDate, timeZone: string): Date {
  // Date.UTC normalises overflow, e.g. day 32 or month 13.
  const guess = Date.UTC(year, month - 1, day);
  const firstPass = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-check the offset at the result, in case a DST change sits in between.
  return new Date(guess - zoneOffsetMs(new Date(firstPass), timeZone));
}

export function startOfDay(now: Date, timeZone: string): Date {
  const { year, month, day } = zonedParts(now, timeZone);
  return zonedMidnight({ year, month, day }, timeZone);
}

export function startOfNextDay(now: Date, timeZone: string): Date {
  const { year, month, day } = zonedParts(now, timeZone);
  return zonedMidnight({ year, month, day: day + 1 }, timeZone);
}

export function startOfMonth(now: Date, timeZone: string): Date {
  const { year, month } = zonedParts(now, timeZone);
  return zonedMidnight({ year, month, day: 1 }, timeZone);
}

export function startOfNextMonth(now: Date, timeZone: string): Date {
  const { year, month } = zonedParts(now, timeZone);
  return zonedMidnight({ year, month: month + 1, day: 1 }, timeZone);
}
