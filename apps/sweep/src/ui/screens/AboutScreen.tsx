import { Linking, View } from "react-native";
import { config, integrityEnabled } from "../../config";
import { LANGS } from "../../i18n/strings";
import { useApp } from "../AppContext";
import { Body, Button, Card, H2, Note, Screen } from "../components/ui";

export function AboutScreen() {
  const { t, lang, setLang, voiceOn, setVoiceOn, deviceId } = useApp();
  return (
    <Screen title={t.aboutTitle}>
      {t.machineDrafted ? <Note icon="alert" tone="warn">{t.machineDrafted}</Note> : null}
      <Card>
        <H2>{t.methodHeading}</H2>
        {t.method.map((m) => (
          <Body key={m}>{m}</Body>
        ))}
        <Body>{t.dataCost}</Body>
      </Card>
      <Card>
        <H2>{t.contact}</H2>
        <Button label={config.contactEmail} icon="info" kind="secondary" onPress={() => Linking.openURL(`mailto:${config.contactEmail}`)} />
        <H2>{t.dpo}</H2>
        <Body>{config.dpoContact}</Body>
      </Card>
      <Card>
        <H2>{t.language}</H2>
        <View style={{ gap: 8 }}>
          {LANGS.map((l) => (
            <Button key={l.code} label={l.name} icon={lang === l.code ? "check" : "globe"} kind={lang === l.code ? "primary" : "secondary"} onPress={() => setLang(l.code)} />
          ))}
        </View>
        <Button label={voiceOn ? t.speakOn : t.speakOff} icon="speaker" kind="secondary" onPress={() => setVoiceOn(!voiceOn)} />
      </Card>
      <Card>
        <Body muted>
          {t.version}: {config.appVersion}
          {integrityEnabled ? "" : " (dev build: Play Integrity off)"}
        </Body>
        <Body muted selectable>
          {t.deviceId}: {deviceId ?? "-"}
        </Body>
      </Card>
    </Screen>
  );
}
