import { View } from "react-native";
import { LANGS } from "../../i18n/strings";
import { useApp } from "../AppContext";
import { Body, Button, Card, H2, Note, Screen } from "../components/ui";

export function ConsentScreen({ onAgree }: { onAgree: () => void }) {
  const { t, lang, setLang } = useApp();
  return (
    <Screen title={t.consentTitle}>
      <Card>
        <H2>{t.chooseLanguage}</H2>
        <View style={{ gap: 8 }}>
          {LANGS.map((l) => (
            <Button
              key={l.code}
              label={l.name}
              icon={lang === l.code ? "check" : "globe"}
              kind={lang === l.code ? "primary" : "secondary"}
              onPress={() => setLang(l.code)}
            />
          ))}
        </View>
      </Card>
      {t.machineDrafted ? (
        <Note icon="alert" tone="warn">
          {t.machineDrafted}
        </Note>
      ) : null}
      <Body>{t.consentIntro}</Body>
      <Card>
        <H2>{t.collectHeading}</H2>
        {t.collectItems.map((s) => (
          <Body key={s}>{"• " + s}</Body>
        ))}
      </Card>
      <Card>
        <H2>{t.notCollectHeading}</H2>
        {t.notCollectItems.map((s) => (
          <Body key={s}>{"• " + s}</Body>
        ))}
      </Card>
      <Note icon="info">{t.dataCost}</Note>
      <Button label={t.agree} icon="check" onPress={onAgree} big />
    </Screen>
  );
}
