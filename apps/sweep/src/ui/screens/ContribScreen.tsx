import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { QueueItem } from "../../protocol/queue";
import { eraseData, queue, sync } from "../../services";
import { useApp } from "../AppContext";
import { Body, Button, Card, Note, Screen, colors } from "../components/ui";

export function ContribScreen() {
  const { t } = useApp();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState<"sync" | "delete" | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);

  const reload = useCallback(async () => setItems(await queue.list()), []);

  useEffect(() => {
    reload();
    return sync.onChange(() => {
      reload();
    });
  }, [reload]);

  const syncNow = async () => {
    setBusy("sync");
    try {
      await sync.sync();
    } finally {
      setBusy(null);
      reload();
    }
  };

  const doDelete = async () => {
    setBusy("delete");
    try {
      const r = await eraseData();
      setMessage({ text: t.deleted(r.testsDeleted), tone: "info" });
    } catch {
      setMessage({ text: t.deleteFailed, tone: "danger" });
    } finally {
      setBusy(null);
      reload();
    }
  };

  const confirmDelete = () =>
    Alert.alert(t.deleteData, t.deleteConfirm, [
      { text: t.back, style: "cancel" },
      { text: t.deleteData, style: "destructive", onPress: doDelete },
    ]);

  const pendingCount = items.filter((i) => i.state === "pending").length;

  return (
    <Screen title={t.contribTitle}>
      {message ? <Note icon={message.tone === "info" ? "check" : "alert"} tone={message.tone}>{message.text}</Note> : null}
      {pendingCount > 0 ? <Button label={`${t.syncNow} (${pendingCount})`} icon="sync" onPress={syncNow} busy={busy === "sync"} /> : null}
      {items.length === 0 ? <Body muted>{t.empty}</Body> : null}
      {items.map((i) => {
        const okSims = i.payload.sims.filter((s) => s.upload.ok).length;
        const state =
          i.state === "synced"
            ? `${t.synced}: ${i.response?.status ?? ""}${i.response?.reject_reason ? ` (${i.response.reject_reason})` : ""}`
            : i.state === "pending"
              ? t.pending
              : `${t.failed} (${(i.last_error ?? "").split(":")[0]})`;
        return (
          <Card key={i.id}>
            <Body style={{ fontWeight: "700" }}>{i.pu_code}</Body>
            <Body muted>{new Date(i.created_at).toLocaleString()}</Body>
            <Body>
              SIM: {i.payload.sims.map((s) => s.mcc_mnc).join(", ")} · {okSims}/{i.payload.sims.length} ✓
            </Body>
            <Body style={{ color: i.state === "synced" ? colors.ok : i.state === "pending" ? colors.warn : colors.danger, fontWeight: "600" }}>
              {state}
            </Body>
          </Card>
        );
      })}
      <View style={{ marginTop: 16 }}>
        <Button label={t.deleteData} icon="trash" kind="danger" onPress={confirmDelete} busy={busy === "delete"} />
      </View>
    </Screen>
  );
}
