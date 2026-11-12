import { Text, View } from "react-native";
import type { NearbyUnit } from "../../contracts";
import { registeredLevel } from "../../protocol/cells";
import type { RunOutcome } from "../../protocol/run";
import { useApp } from "../AppContext";
import { Body, Button, Card, H2, Note, Screen, SignalBars, colors } from "../components/ui";

export function ResultScreen({ unit, outcome }: { unit: NearbyUnit; outcome: Extract<RunOutcome, { kind: "completed" }> }) {
  const { t, go } = useApp();
  const { payload, submit, offline, place } = outcome;

  let status: { text: string; tone: "info" | "warn" | "danger" };
  if (submit.state === "synced") {
    const s = submit.response.status;
    status =
      s === "accepted"
        ? { text: t.statusAccepted, tone: "info" }
        : s === "quarantined"
          ? { text: t.statusQuarantined, tone: "warn" }
          : { text: `${t.statusRejected}${submit.response.reject_reason ? ` (${submit.response.reject_reason})` : ""}`, tone: "danger" };
  } else if (submit.state === "pending") {
    status = { text: t.statusQueued, tone: "warn" };
  } else {
    status = { text: `${t.statusRejected} (${submit.code})`, tone: "danger" };
  }

  // The server's count after this test; until it is synced, the count from before (a queued test is not counted yet).
  const needed = submit.state === "synced" ? submit.response.progress.needed : unit.progress.needed;

  return (
    <Screen title={t.resultTitle}>
      <Card>
        <Body style={{ fontWeight: "700", fontSize: 18 }}>{unit.name}</Body>
        <Body muted>{unit.pu_code}</Body>
      </Card>
      <Note icon={status.tone === "info" ? "check" : "alert"} tone={status.tone}>
        {status.text}
      </Note>
      {offline ? <Note icon="info" tone="warn">{t.offlineRun}</Note> : null}
      {place.kind === "location_vote" ? <Note icon="pin">{t.locationVote}</Note> : null}

      {payload.sims.map((sim) => (
        <Card key={sim.slot}>
          <H2>
            SIM {sim.slot + 1} · {sim.mcc_mnc}
            {sim.net_type ? ` · ${sim.net_type}` : ""}
          </H2>
          <SignalBars level={registeredLevel(sim.cells)} label={t.signal} />
          <Body>
            {sim.upload.ok && sim.upload.total_ms != null
              ? t.uploadTime(sim.upload.total_ms / 1000)
              : t.uploadFailed(sim.upload.err ?? "?")}
          </Body>
        </Card>
      ))}

      <View accessible accessibilityRole="summary" style={{ paddingVertical: 8 }}>
        <Text style={{ fontSize: 22, fontWeight: "700", color: needed === 0 ? colors.ok : colors.ink, textAlign: "center" }}>
          {needed === 0 ? t.unitMeasured : t.needsMore(needed)}
        </Text>
      </View>

      <Button label={t.done} icon="check" onPress={() => go({ name: "find" })} big />
      <Button label={t.navContrib} icon="list" kind="secondary" onPress={() => go({ name: "contrib" })} />
    </Screen>
  );
}
