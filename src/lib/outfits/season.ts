import type { Season } from "@/contracts";

/**
 * The season "now" in the UK, by meteorological seasons: spring is March to
 * May, summer June to August, autumn September to November, winter
 * December to February. The request has no date or destination, so the
 * filter uses today's UK season (testers are UK based).
 */
export function seasonAt(date: Date, timeZone = "Europe/London"): Season {
  const month = Number(new Intl.DateTimeFormat("en-GB", { month: "numeric", timeZone }).format(date));
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}
