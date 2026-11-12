// Config plugin for APK size on 2 GB phones:
// - per-ABI APKs (armeabi-v7a, arm64-v8a) for sideloaded release builds, so each APK carries one copy of the
//   native libraries. App bundles (AAB) ignore `splits`; Google Play splits those itself.
//   Set POS_UNIVERSAL_APK=1 at build time to get one APK per build type instead (e.g. for EAS internal builds).
// - drops the animated GIF and WebP decoders the app never uses.
const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

const MARKER = "// @proof-of-signal abi-splits";

function addSplits(gradle) {
  if (gradle.includes(MARKER)) return gradle;
  const block = `
    ${MARKER}
    splits {
        abi {
            enable (System.getenv("POS_UNIVERSAL_APK") == null)
            reset()
            include "armeabi-v7a", "arm64-v8a"
            universalApk false
        }
    }
`;
  const anchor = /\nandroid\s*\{\n/;
  if (!anchor.test(gradle)) throw new Error("withAbiSplits: could not find the android { block in app/build.gradle");
  return gradle.replace(anchor, (m) => m + block);
}

function setProp(props, key, value) {
  const existing = props.find((p) => p.type === "property" && p.key === key);
  if (existing) existing.value = value;
  else props.push({ type: "property", key, value });
}

module.exports = function withAbiSplits(config) {
  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") throw new Error("withAbiSplits: expected a Groovy build.gradle");
    cfg.modResults.contents = addSplits(cfg.modResults.contents);
    return cfg;
  });
  return withGradleProperties(config, (cfg) => {
    setProp(cfg.modResults, "expo.gif.enabled", "false");
    setProp(cfg.modResults, "expo.webp.enabled", "false");
    setProp(cfg.modResults, "expo.webp.animated", "false");
    return cfg;
  });
};

module.exports.addSplits = addSplits;
