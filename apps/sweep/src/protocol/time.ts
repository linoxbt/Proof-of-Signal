/** RFC 3339 timestamp with the device's UTC offset and whole seconds, e.g. 2026-12-02T19:14:05+01:00. */
export function rfc3339Local(d: Date): string {
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60000);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return local.toISOString().slice(0, 19) + sign + hh + ":" + mm;
}

/** West Africa Time (UTC+1, no DST) hour of day, independent of the phone's time zone setting. */
export function watHour(d: Date): number {
  return (d.getUTCHours() + 1) % 24;
}

/** The API labels a test only between 17:00 and 23:59 WAT. */
export function isEveningWindow(d: Date): boolean {
  return watHour(d) >= 17;
}
