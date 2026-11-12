import { getLocales } from "expo-localization";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { STRINGS, type Lang, type Strings } from "./src/i18n/strings";
import { KV_DEVICE_ID } from "./src/protocol/device";
import { kv, register, speak, startAutoSync } from "./src/services";
import { AppCtx, type AppState, type Route } from "./src/ui/AppContext";
import { Icon, type IconName } from "./src/ui/components/Icon";
import { colors } from "./src/ui/components/ui";
import { AboutScreen } from "./src/ui/screens/AboutScreen";
import { ConsentScreen } from "./src/ui/screens/ConsentScreen";
import { ContribScreen } from "./src/ui/screens/ContribScreen";
import { FindScreen } from "./src/ui/screens/FindScreen";
import { ResultScreen } from "./src/ui/screens/ResultScreen";
import { RunScreen } from "./src/ui/screens/RunScreen";

const CONSENT_KEY = "consent_v1";
const LANG_KEY = "lang";
const VOICE_KEY = "voice";

function defaultLang(): Lang {
  const code = getLocales()[0]?.languageCode ?? "en";
  return (["ha", "yo", "ig", "pcm"] as const).find((l) => l === code) ?? "en";
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<Lang>(defaultLang());
  const [voiceOn, setVoiceState] = useState(true);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>({ name: "consent" });
  const registering = useRef<Promise<string> | null>(null);

  useEffect(() => {
    (async () => {
      const [l, v, c, d] = await Promise.all([kv.get(LANG_KEY), kv.get(VOICE_KEY), kv.get(CONSENT_KEY), kv.get(KV_DEVICE_ID)]);
      if (l && l in STRINGS) setLangState(l as Lang);
      if (v) setVoiceState(v === "1");
      setDeviceId(d);
      setRoute(c ? { name: "find" } : { name: "consent" });
      setReady(true);
    })();
    return startAutoSync();
  }, []);

  const ensureDevice = useCallback(async () => {
    if (deviceId) return deviceId;
    registering.current ??= register()
      .then((r) => {
        setDeviceId(r.deviceId);
        return r.deviceId;
      })
      .finally(() => {
        registering.current = null;
      });
    return registering.current;
  }, [deviceId]);

  const t = STRINGS[lang];
  const state: AppState = useMemo(
    () => ({
      lang,
      t,
      setLang: (l) => {
        setLangState(l);
        kv.set(LANG_KEY, l);
      },
      voiceOn,
      setVoiceOn: (v) => {
        setVoiceState(v);
        kv.set(VOICE_KEY, v ? "1" : "0");
      },
      deviceId,
      ensureDevice,
      go: setRoute,
      say: (pick: (s: Strings) => string) => {
        if (voiceOn) speak(lang, pick(t), pick(STRINGS.en));
      },
    }),
    [lang, t, voiceOn, deviceId, ensureDevice],
  );

  if (!ready) {
    return (
      <View style={[styles.root, { justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const agree = async () => {
    await kv.set(CONSENT_KEY, JSON.stringify({ at: new Date().toISOString(), lang }));
    setRoute({ name: "find" });
    // Register in the background on first launch; a run retries if this fails offline.
    ensureDevice().catch(() => {});
  };

  let screen;
  switch (route.name) {
    case "consent":
      screen = <ConsentScreen onAgree={agree} />;
      break;
    case "find":
      screen = <FindScreen />;
      break;
    case "run":
      screen = <RunScreen unit={route.unit} />;
      break;
    case "result":
      screen = <ResultScreen unit={route.unit} outcome={route.outcome} />;
      break;
    case "contrib":
      screen = <ContribScreen />;
      break;
    case "about":
      screen = <AboutScreen />;
      break;
  }

  const showNav = route.name !== "consent" && route.name !== "run";
  return (
    <AppCtx.Provider value={state}>
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <StatusBar style="dark" />
        <View style={{ flex: 1 }}>{screen}</View>
        {showNav ? (
          <View style={styles.nav} accessibilityRole="tablist">
            <NavItem icon="pin" label={t.navFind} active={route.name === "find"} onPress={() => setRoute({ name: "find" })} />
            <NavItem icon="list" label={t.navContrib} active={route.name === "contrib"} onPress={() => setRoute({ name: "contrib" })} />
            <NavItem icon="info" label={t.navAbout} active={route.name === "about"} onPress={() => setRoute({ name: "about" })} />
          </View>
        ) : null}
      </SafeAreaView>
    </AppCtx.Provider>
  );
}

function NavItem({ icon, label, active, onPress }: { icon: IconName; label: string; active: boolean; onPress: () => void }) {
  const c = active ? colors.primary : colors.muted;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.navItem}
    >
      <Icon name={icon} color={c} size={24} />
      <Text style={[styles.navText, { color: c }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  nav: { flexDirection: "row", borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  navItem: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", paddingVertical: 6, gap: 2 },
  navText: { fontSize: 13, fontWeight: "600", textAlign: "center" },
});
