// Shared API types. Everything in contracts/types.ts is re-exported; the
// response shapes that contracts/api.md defines but types.ts does not are
// declared here, following api.md exactly.
import type { Flag, PublicBucket, RegisterRow } from "../../../../../contracts/types.ts";

export type {
  ApiError as ApiErrorBody,
  CarrierCoverage,
  CoverageResponse,
  Evidence,
  Flag,
  FlagClass,
  NightSummary,
  PublicBucket,
  RegisterRow,
  ReviewDecision,
  ReviewStatus,
} from "../../../../../contracts/types.ts";

export interface PointFeature<P> {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: P;
}

export interface FeatureCollection<P> {
  type: "FeatureCollection";
  features: PointFeature<P>[];
}

/** `GET /v1/map/coverage` feature properties. `carriers` maps MNC (string) to p. */
export interface CoverageFeatureProps {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  p_best: number | null;
  p_lo: number | null;
  p_hi: number | null;
  n_tests: number;
  measured: boolean;
  carriers: Record<string, number>;
}

export interface LgaProgress {
  lga_code: number;
  lga: string;
  units: number;
  tested: number;
  measured: number;
}

export interface MapProgressResponse {
  lgas: LgaProgress[];
}

export interface RegisterResponse {
  model_version: string | null;
  rows: RegisterRow[];
}

export interface SnapshotRef {
  id: string;
  sha256: string;
  frozen_at: string;
  model_version: string;
  tsa_at: string | null;
}

export interface Election {
  id: string;
  name: string;
  election_date: string;
  state_codes: number[];
  polls_close_at: string;
  is_replay: boolean;
  snapshot: SnapshotRef | null;
}

export interface ElectionsResponse {
  elections: Election[];
}

export type IrevState = "pending" | "uploaded" | "cancelled";
export type ReviewOutcome = "explained" | "concern_raised";

/** `GET /v1/night/{election}/units` feature properties. */
export interface NightUnitProps {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  irev_state: IrevState;
  first_seen_at: string | null;
  bucket: PublicBucket;
  review_outcome: ReviewOutcome | null;
}

export interface ModelVersion {
  id: string;
  trained_at: string;
  metrics: Record<string, unknown>;
  is_current: boolean;
}

export interface MethodSnapshot {
  id: string;
  election_id: string;
  model_version: string;
  frozen_at: string;
  sha256: string;
  row_count: number;
  tsa_at: string | null;
}

export interface AuditRoot {
  day: string;
  root_hash: string;
  tsa_at: string | null;
}

export interface MethodResponse {
  model_versions: ModelVersion[];
  snapshots: MethodSnapshot[];
  audit_roots: AuditRoot[];
}

export interface FlagsResponse {
  flags: Flag[];
}

export interface PuSearchUnit {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
  lat: number | null;
  lng: number | null;
}
