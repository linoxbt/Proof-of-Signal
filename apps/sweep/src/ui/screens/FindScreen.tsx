// Nearest 5 units as a list plus a tile-free relative plot (you at the centre, units by bearing and distance).
// A MapLibre map was left out on purpose: its native library costs ~5-8 MB per ABI and tiles need data and RAM
// that 2 GB phones on metered data do not have. The list works offline from the last cached result.
import { useCallback, useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import Svg, { Circle, G, Line, Text as SvgText } from "react-native-svg";
import type { NearbyUnit } from "../../contracts";
import { roughPosition } from "../../native/adapters";
import { bearingDeg, distanceM } from "../../protocol/geo";
import { api, kv } from "../../services";
import { useApp } from "../AppContext";
import { Body, Button, Card, H2, Note, Screen, colors } from "../components/ui";

const CACHE_KEY = "units_cache";

export function FindScreen() {
  const { t, go } = useApp();
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [units, setUnits] = useState<NearbyUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [cached, setCached] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<NearbyUnit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadNearby = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await roughPosition();
      setPos(p);
      if (!p) throw new Error("no position");
      const list = await api.nearby(p.lat, p.lng, 2000, 5);
      setUnits(list);
      setCached(false);
      await kv.set(CACHE_KEY, JSON.stringify(list));
    } catch {
      const c = await kv.get(CACHE_KEY);
      if (c) {
        setUnits(JSON.parse(c));
        setCached(true);
      } else {
        setError(t.noUnits);
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadNearby();
  }, [loadNearby]);

  const search = async () => {
    const term = q.trim();
    if (!term) return;
    setLoading(true);
    try {
      setResults(await api.search(term, 10));
    } catch {
      // Offline: search the cached units.
      const c: NearbyUnit[] = JSON.parse((await kv.get(CACHE_KEY)) ?? "[]");
      const lower = term.toLowerCase();
      setResults(c.filter((u) => u.pu_code.startsWith(term) || u.name.toLowerCase().includes(lower)));
    } finally {
      setLoading(false);
    }
  };

  const pick = (u: NearbyUnit) => go({ name: "run", unit: u });

  return (
    <Screen title={t.findTitle}>
      <Card>
        <Text nativeID="searchLabel" style={{ fontSize: 16, color: colors.ink }}>
          {t.searchLabel}
        </Text>
        <TextInput
          accessibilityLabelledBy="searchLabel"
          accessibilityLabel={t.searchLabel}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={search}
          placeholder="24-05-11-003"
          autoCapitalize="none"
          returnKeyType="search"
          style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, fontSize: 18, color: colors.ink }}
        />
        <Button label={t.searchButton} icon="search" onPress={search} busy={loading && results === null && q !== ""} />
      </Card>

      {results ? (
        <>
          <H2>{t.searchButton}</H2>
          {results.length === 0 ? <Body>{t.noUnits}</Body> : results.map((u) => <UnitCard key={u.pu_code} unit={u} pos={pos} onPick={pick} />)}
        </>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <H2>{t.nearby}</H2>
        <Button label={t.refresh} icon="refresh" kind="secondary" onPress={loadNearby} busy={loading} />
      </View>
      {cached ? <Note icon="info" tone="warn">{t.cachedList}</Note> : null}
      {loading && units.length === 0 ? <Body muted>{t.locating}</Body> : null}
      {error ? <Body>{error}</Body> : null}
      {pos && units.length > 0 ? <UnitPlot pos={pos} units={units} /> : null}
      {units.map((u, i) => (
        <UnitCard key={u.pu_code} unit={u} pos={pos} onPick={pick} index={i + 1} />
      ))}
    </Screen>
  );
}

function UnitCard({ unit, pos, onPick, index }: { unit: NearbyUnit; pos: { lat: number; lng: number } | null; onPick: (u: NearbyUnit) => void; index?: number }) {
  const { t } = useApp();
  const d = unit.dist_m ?? (pos && unit.lat != null && unit.lng != null ? distanceM(pos.lat, pos.lng, unit.lat, unit.lng) : null);
  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: "700", color: colors.ink }}>
        {index ? `${index}. ` : ""}
        {unit.name}
      </Text>
      <Body muted>
        {unit.pu_code} · {unit.ward}, {unit.lga}
      </Body>
      {d != null ? <Body>{t.metresAway(d)}</Body> : null}
      {unit.lat == null ? <Body>{t.noPoint}</Body> : null}
      <Body style={{ fontWeight: "600", color: unit.progress.measured ? colors.ok : colors.warn }}>
        {unit.progress.measured ? t.measured : t.needsTests(unit.progress.needed)}
      </Body>
      <Button label={t.runTitle} icon="pin" onPress={() => onPick(unit)} />
    </Card>
  );
}

function UnitPlot({ pos, units }: { pos: { lat: number; lng: number }; units: NearbyUnit[] }) {
  const size = 240;
  const c = size / 2;
  const pts = units
    .filter((u) => u.lat != null && u.lng != null)
    .map((u, i) => ({ i: i + 1, d: distanceM(pos.lat, pos.lng, u.lat!, u.lng!), b: bearingDeg(pos.lat, pos.lng, u.lat!, u.lng!) }));
  const maxD = Math.max(200, ...pts.map((p) => p.d));
  return (
    <View style={{ alignItems: "center" }} accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size}>
        <Circle cx={c} cy={c} r={c - 4} stroke={colors.border} strokeWidth={1} fill={colors.card} />
        <Circle cx={c} cy={c} r={(c - 4) / 2} stroke={colors.border} strokeWidth={1} fill="none" />
        <Line x1={c} y1={6} x2={c} y2={18} stroke={colors.muted} strokeWidth={2} />
        <SvgText x={c + 6} y={18} fontSize={12} fill={colors.muted}>
          N
        </SvgText>
        <Circle cx={c} cy={c} r={6} fill={colors.danger} />
        {pts.map((p) => {
          const r = ((c - 20) * p.d) / maxD;
          const rad = (p.b * Math.PI) / 180;
          const x = c + r * Math.sin(rad);
          const y = c - r * Math.cos(rad);
          return (
            <G key={p.i}>
              <Circle cx={x} cy={y} r={12} fill={colors.primary} />
              <SvgText x={x} y={y + 5} fontSize={14} fontWeight="bold" fill="#fff" textAnchor="middle">
                {String(p.i)}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}
