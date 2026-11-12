import { IS_DEMO, DEMO_STATE_CODE } from "./config";

/** INEC state codes (alphabetical, FCT last). */
export const NIGERIAN_STATES: { code: number; name: string }[] = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta",
  "Ebonyi", "Edo", "Ekiti", "Enugu", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi",
  "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto",
  "Taraba", "Yobe", "Zamfara", "FCT Abuja",
].map((name, i) => ({ code: i + 1, name }));

export const DEMO_STATE = { code: DEMO_STATE_CODE, name: "Demo State (synthetic, code 99)" };

export function stateOptions(): { code: number; name: string }[] {
  return IS_DEMO ? [DEMO_STATE] : [...NIGERIAN_STATES, DEMO_STATE];
}

/** "99-01-01-002" → 99 */
export function stateCodeFromPu(puCode: string): number | null {
  const n = Number(puCode.split("-")[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
