import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { NearbyUnit } from "../../contracts";
import { config } from "../../config";
import type { AbortReason, Phase, RunEvent, RunOutcome, TestRun } from "../../protocol/run";
import { isEveningWindow } from "../../protocol/time";
import { newRun, requestRunPermissions } from "../../services";
import { useApp } from "../AppContext";
import { Body, Button, Card, Note, ProgressRing, Screen } from "../components/ui";

export function RunScreen({ unit }: { unit: NearbyUnit }) {
  const { t, go, say, ensureDevice } = useApp();
  const [event, setEvent] = useState<RunEvent | null>(null);
  const [running, setRunning] = useState(false);
  const [aborted, setAborted] = useState<{ reason: AbortReason | "permissions" | "register"; detail?: string; distanceM?: number } | null>(null);
  const runRef = useRef<TestRun | null>(null);
  const lastSpoken = useRef<Phase | null>(null);

  useEffect(() => () => runRef.current?.cancel(), []);

  const onEvent = (e: RunEvent) => {
    setEvent(e);
    if (e.phase !== lastSpoken.current && e.phase !== "done" && e.phase !== "aborted") {
      lastSpoken.current = e.phase;
      say((s) => s.phase[e.phase]);
    }
  };

  const start = async () => {
    setAborted(null);
    lastSpoken.current = null;
    if (!(await requestRunPermissions())) {
      setAborted({ reason: "permissions" });
      say((s) => s.abort.permissions);
      return;
    }
    let deviceId: string;
    try {
      deviceId = await ensureDevice();
    } catch {
      setAborted({ reason: "register" });
      say((s) => s.registerFailed);
      return;
    }
    const run = newRun(
      { deviceId, unit: { pu_code: unit.pu_code, lat: unit.lat, lng: unit.lng }, appVersion: config.appVersion, probeBase: config.probeBase },
      onEvent,
    );
    runRef.current = run;
    setRunning(true);
    let outcome: RunOutcome;
    try {
      outcome = await run.run();
    } catch (e) {
      outcome = { kind: "aborted", reason: "api_error", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      setRunning(false);
      runRef.current = null;
    }
    if (outcome.kind === "completed") {
      say((s) => s.phase.done);
      go({ name: "result", unit, outcome });
    } else {
      setAborted({ reason: outcome.reason, detail: outcome.detail, distanceM: outcome.distanceM });
      say((s) => s.abort[outcome.reason as AbortReason]);
    }
  };

  const phase: Phase = event?.phase ?? "idle";
  const evening = isEveningWindow(new Date());
  const abortText =
    aborted?.reason === "register"
      ? t.registerFailed
      : aborted
        ? t.abort[aborted.reason as keyof typeof t.abort] + (aborted.detail ? ` (${aborted.detail})` : "")
        : null;

  return (
    <Screen title={t.runTitle} onBack={running ? undefined : () => go({ name: "find" })} backLabel={t.back}>
      <Card>
        <Body style={{ fontWeight: "700", fontSize: 18 }}>{unit.name}</Body>
        <Body muted>
          {unit.pu_code} · {unit.ward}, {unit.lga}
        </Body>
      </Card>
      {!evening ? <Note icon="info" tone="warn">{t.evening}</Note> : null}
      <ProgressRing progress={running ? (event?.progress ?? 0) : phase === "done" ? 1 : 0} label={t.phase[phase]} />
      <Body style={{ textAlign: "center", fontSize: 18 }}>
        {t.phase[running ? phase : "idle"]}
        {running && event?.sim ? `\n${t.simOf(event.sim.index + 1, event.sim.count)}` : ""}
      </Body>
      {abortText ? (
        <Note icon="alert" tone="danger">
          {abortText}
          {aborted?.distanceM != null ? `\n${t.distanceNote(aborted.distanceM)}` : ""}
        </Note>
      ) : null}
      <View style={{ gap: 12 }}>
        {running ? (
          <Button label={t.cancel} icon="stop" kind="danger" onPress={() => runRef.current?.cancel()} />
        ) : (
          <Button label={t.start} icon="play" onPress={start} big />
        )}
      </View>
      <Note icon="info">{t.dataCost}</Note>
    </Screen>
  );
}
