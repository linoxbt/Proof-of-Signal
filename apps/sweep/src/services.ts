// Wiring: real adapters into the protocol. Screens import from here, never from src/native directly.
import NetInfo from "@react-native-community/netinfo";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import { PermissionsAndroid, Platform } from "react-native";
import { config } from "./config";
import { LANGS, type Lang } from "./i18n/strings";
import { integrity, keys, location, net, radio } from "./native/adapters";
import { sqliteKv, sqliteQueue } from "./native/sqlite";
import { HttpApi } from "./protocol/api";
import { ensureRegistered, eraseMyData } from "./protocol/device";
import { systemClock } from "./protocol/ports";
import { SyncEngine } from "./protocol/queue";
import { TestRun, type RunDeps, type RunEvent, type RunInput } from "./protocol/run";

export const api = new HttpApi(config.apiBase);
export const kv = sqliteKv;
export const queue = sqliteQueue;
export const sync = new SyncEngine(queue, api);

export const runDeps: RunDeps = {
  radio,
  keys,
  integrity,
  location,
  api,
  net,
  clock: systemClock,
  submit: (p) => sync.submit(p),
};

export function newRun(input: RunInput, onEvent: (e: RunEvent) => void): TestRun {
  return new TestRun(runDeps, input, onEvent);
}

export function register() {
  return ensureRegistered({ keys, integrity, api, kv }, config.appVersion);
}

export function eraseData() {
  return eraseMyData({ keys, api, kv, queue, clock: systemClock });
}

/** Sync whenever any connection appears, and once at start. Returns the unsubscribe function. */
export function startAutoSync(): () => void {
  let wasOnline = false;
  const unsub = NetInfo.addEventListener((s) => {
    const online = !!s.isConnected && s.isInternetReachable !== false;
    if (online && !wasOnline) sync.sync().catch(() => {});
    wasOnline = online;
  });
  sync.sync().catch(() => {});
  return unsub;
}

/** Foreground permissions for a run: fine (+coarse) location and phone state. */
export async function requestRunPermissions(): Promise<boolean> {
  const loc = await Location.requestForegroundPermissionsAsync();
  if (loc.status !== "granted") return false;
  if (Platform.OS !== "android") return false;
  const phone = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE);
  return phone === PermissionsAndroid.RESULTS.GRANTED;
}

let voices: Speech.Voice[] | null = null;

/**
 * Speak a prompt in the chosen language when the phone has a voice for it; otherwise speak the English prompt
 * (most phones have no Hausa, Yoruba or Igbo voice, and reading those spellings with an English voice is worse).
 */
export async function speak(lang: Lang, text: string, englishText: string): Promise<void> {
  try {
    voices ??= await Speech.getAvailableVoicesAsync();
    const want = LANGS.find((l) => l.code === lang)!.speech;
    const has = voices.some((v) => v.language.toLowerCase().startsWith(want.toLowerCase().split("-")[0]));
    Speech.stop();
    if (has || lang === "pcm") Speech.speak(text, { language: want });
    else Speech.speak(englishText, { language: "en-NG" });
  } catch {
    // Speech is a help, never a blocker.
  }
}
