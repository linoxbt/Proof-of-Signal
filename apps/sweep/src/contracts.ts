// The single place the app reaches into the shared contracts. Type-only, erased by Babel and tsc.
export type {
  CellObservation,
  NearbyUnit,
  Progress,
  RadioType,
  SimResult,
  TestPayload,
  TestResponse,
  UploadResult,
  ApiError as ApiErrorBody,
} from "../../../contracts/types.ts";
