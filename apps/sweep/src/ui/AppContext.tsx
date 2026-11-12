import { createContext, useContext } from "react";
import type { NearbyUnit } from "../contracts";
import type { Lang, Strings } from "../i18n/strings";
import type { RunOutcome } from "../protocol/run";

export type Route =
  | { name: "consent" }
  | { name: "find" }
  | { name: "run"; unit: NearbyUnit }
  | { name: "result"; unit: NearbyUnit; outcome: Extract<RunOutcome, { kind: "completed" }> }
  | { name: "contrib" }
  | { name: "about" };

export interface AppState {
  lang: Lang;
  t: Strings;
  setLang(l: Lang): void;
  voiceOn: boolean;
  setVoiceOn(v: boolean): void;
  deviceId: string | null;
  ensureDevice(): Promise<string>;
  go(r: Route): void;
  say(pick: (s: Strings) => string): void;
}

export const AppCtx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error("AppCtx missing");
  return v;
}
