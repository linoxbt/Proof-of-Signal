export const PLACE_RADIUS_M = 150;
export const MAX_ACCURACY_M = 30;

/** Great-circle distance in metres (haversine, mean Earth radius). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees clockwise from north, for the relative "where is it" plot. */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * toRad) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lng2 - lng1) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export type PlaceCheck =
  | { kind: "ok"; distanceM: number }
  | { kind: "too_far"; distanceM: number }
  | { kind: "location_vote" };

/**
 * The API quarantines a test more than 150 m from the unit's point. The app refuses to run such a test, so a
 * volunteer is told to walk closer instead of wasting data. A unit with no point yet accepts the fix as a vote.
 */
export function checkPlace(
  fix: { lat: number; lng: number },
  unit: { lat: number | null; lng: number | null },
  radiusM = PLACE_RADIUS_M,
): PlaceCheck {
  if (unit.lat == null || unit.lng == null) return { kind: "location_vote" };
  const d = distanceM(fix.lat, fix.lng, unit.lat, unit.lng);
  return d <= radiusM ? { kind: "ok", distanceM: d } : { kind: "too_far", distanceM: d };
}
