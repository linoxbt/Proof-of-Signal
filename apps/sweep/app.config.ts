import type { ConfigContext, ExpoConfig } from "expo/config";

// Build-time configuration. Values come from the environment (EAS build profiles set them in eas.json).
//   API_BASE                              e.g. https://<ref>.supabase.co/functions/v1/api
//   PROBE_BASE                            e.g. https://probe.<domain>  (DNS-only, never proxied)
//   PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER   Google Cloud project number; empty = dev build without Play Integrity
//   CONTACT_EMAIL, DPO_CONTACT            shown on the About screen
const env = process.env;

const projectNumber = (env.PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER ?? "").trim();
if (projectNumber !== "" && !/^\d+$/.test(projectNumber)) {
  throw new Error(`PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER must be digits or empty, got "${projectNumber}"`);
}
if (env.EAS_BUILD_PROFILE === "production" && projectNumber === "") {
  throw new Error("production builds need PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER (dev builds may leave it empty)");
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Proof of Signal",
  slug: "proof-of-signal-sweep",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  platforms: ["android"],
  android: {
    package: "ng.proofofsignal.sweep",
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: "#0B5D3B",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    // Foreground only. COARSE is listed because Android 12+ ignores a FINE request made without it.
    permissions: [
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.READ_PHONE_STATE",
      "android.permission.INTERNET",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.CHANGE_NETWORK_STATE",
    ],
    blockedPermissions: [
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.RECORD_AUDIO",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.VIBRATE",
    ],
  },
  plugins: [
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "Proof of Signal uses your location only during a test, to confirm you are at the polling unit.",
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      },
    ],
    "expo-sqlite",
    "expo-localization",
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 26,
          // Google Play: new apps and updates must target API 36 from 31 Aug 2026.
          targetSdkVersion: 36,
          compileSdkVersion: 37,
          // R8 code shrinking + resource shrinking keep the APK small for 2 GB phones.
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          // Compress native libraries inside the APK (smaller download over mobile data).
          useLegacyPackaging: true,
          // ARM only: every target phone (Tecno, Infinix, itel, Samsung A) is ARM. Split per ABI below.
          buildArchs: ["armeabi-v7a", "arm64-v8a"],
        },
      },
    ],
    "./plugins/withAbiSplits",
  ],
  extra: {
    apiBase: env.API_BASE ?? "http://10.0.2.2:54321/functions/v1/api",
    probeBase: env.PROBE_BASE ?? "http://10.0.2.2:8080",
    playIntegrityCloudProjectNumber: projectNumber,
    contactEmail: env.CONTACT_EMAIL ?? "volunteers@example.org",
    dpoContact: env.DPO_CONTACT ?? "Data Protection Officer: to be appointed (set DPO_CONTACT)",
  },
});
