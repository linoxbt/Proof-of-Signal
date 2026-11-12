import Constants from "expo-constants";

export interface SweepConfig {
  apiBase: string;
  probeBase: string;
  /** Google Cloud project number for Play Integrity; "" in dev builds (tokens become a dev marker). */
  playIntegrityCloudProjectNumber: string;
  contactEmail: string;
  dpoContact: string;
  appVersion: string;
}

type Extra = Partial<Omit<SweepConfig, "appVersion">>;

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

export const config: SweepConfig = {
  apiBase: extra.apiBase ?? "http://10.0.2.2:54321/functions/v1/api",
  probeBase: extra.probeBase ?? "http://10.0.2.2:8080",
  playIntegrityCloudProjectNumber: extra.playIntegrityCloudProjectNumber ?? "",
  contactEmail: extra.contactEmail ?? "volunteers@example.org",
  dpoContact: extra.dpoContact ?? "Data Protection Officer: to be appointed (set DPO_CONTACT)",
  appVersion: Constants.expoConfig?.version ?? "0.0.0",
};

export const integrityEnabled = config.playIntegrityCloudProjectNumber.trim() !== "";
