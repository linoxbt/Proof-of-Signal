// Real implementations of the protocol ports, backed by pos-radio, expo-location, NetInfo and fetch.
import NetInfo from "@react-native-community/netinfo";
import * as Location from "expo-location";
import { PosRadio, type PosRadioNativeModule } from "../../modules/pos-radio";
import { config } from "../config";
import { base64Encode } from "../protocol/bytes";
import type { Fix, IntegrityPort, KeyPort, LocationPort, NetPort, RadioPort } from "../protocol/ports";

function native(): PosRadioNativeModule {
  if (!PosRadio) {
    throw new Error("pos-radio native module missing: run a development build (expo run:android / EAS), not Expo Go");
  }
  return PosRadio;
}

export const radio: RadioPort = {
  subscriptions: () => native().subscriptions(),
  snapshot: () => native().snapshot(),
  bindCellular: (subId, timeoutMs) => native().bindCellular(subId, timeoutMs),
  releaseCellular: (h) => native().releaseCellular(h),
  headProbe: (h, url, t) => native().headProbe(h, url, t),
  uploadProbe: (h, url, size, nonce, t) => native().uploadProbe(h, url, size, nonce, t),
  isMockLocation: () => native().isMockLocation(),
};

export const keys: KeyPort = {
  async ensureKey() {
    const challenge = new Uint8Array(32);
    // Attestation challenge: random, so the certificate chain proves freshness of this key generation.
    if (typeof crypto !== "undefined" && "getRandomValues" in crypto) crypto.getRandomValues(challenge);
    else for (let i = 0; i < challenge.length; i++) challenge[i] = Math.floor(Math.random() * 256);
    await native().ensureKey(base64Encode(challenge));
  },
  publicKey: () => native().getPublicKey(),
  sign: (dataB64) => native().sign(dataB64),
};

export const integrity: IntegrityPort = {
  async token(requestHash) {
    try {
      return await native().integrityToken(config.playIntegrityCloudProjectNumber, requestHash);
    } catch (e) {
      return `error:integrity:${e instanceof Error ? e.message.slice(0, 40) : "unknown"}`;
    }
  },
};

export const net: NetPort = {
  async isOnline() {
    const s = await NetInfo.fetch();
    return !!s.isConnected && s.isInternetReachable !== false;
  },
};

export const location: LocationPort = {
  /** Watch the fused provider until accuracy reaches maxAccM, keeping the best fix seen. */
  getFix(maxAccM, timeoutMs) {
    return new Promise<Fix | null>((resolve) => {
      let best: Fix | null = null;
      let sub: Location.LocationSubscription | null = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub?.remove();
        resolve(best);
      };
      const timer = setTimeout(finish, timeoutMs);
      Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0, mayShowUserSettingsDialog: true },
        (loc) => {
          const acc = loc.coords.accuracy ?? Number.POSITIVE_INFINITY;
          const fix: Fix = { lat: loc.coords.latitude, lng: loc.coords.longitude, accM: acc, mocked: loc.mocked ?? null, time: loc.timestamp };
          if (fix.mocked) {
            best = fix; // surface the mock immediately; the run rejects it
            finish();
            return;
          }
          if (!best || acc < best.accM) best = fix;
          if (acc <= maxAccM) finish();
        },
      )
        .then((s) => {
          if (done) s.remove();
          else sub = s;
        })
        .catch(() => finish());
    });
  },
};

/** A quick fix for "find units near me": any accuracy, short wait, falling back to the last known position. */
export async function roughPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 });
    if (last) return { lat: last.coords.latitude, lng: last.coords.longitude };
    const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: cur.coords.latitude, lng: cur.coords.longitude };
  } catch {
    return null;
  }
}
