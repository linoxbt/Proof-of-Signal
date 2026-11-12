import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";
import { Icon, type IconName } from "./Icon";

export const colors = {
  bg: "#F6F7F4",
  card: "#FFFFFF",
  ink: "#1B1F1C",
  muted: "#4D5651",
  primary: "#0B5D3B", // green, 7.6:1 on white
  primaryText: "#FFFFFF",
  danger: "#A3261B",
  warn: "#8A5A00",
  border: "#C9CEC9",
  ok: "#1E7A3E",
};

/** Every action: icon + text, at least 48 dp tall, grows with the font scale. */
export function Button({
  label,
  icon,
  onPress,
  kind = "primary",
  disabled,
  busy,
  big,
  style,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  big?: boolean;
  style?: ViewStyle;
}) {
  const bg = kind === "primary" ? colors.primary : kind === "danger" ? colors.danger : colors.card;
  const fg = kind === "secondary" ? colors.primary : colors.primaryText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        big && styles.bigButton,
        { backgroundColor: bg, borderColor: kind === "secondary" ? colors.primary : bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Icon name={icon} color={fg} size={big ? 36 : 24} />}
      <Text style={[styles.buttonText, big && styles.bigButtonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Screen({ title, children, onBack, backLabel }: { title: string; children: ReactNode; onBack?: () => void; backLabel?: string }) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable accessibilityRole="button" accessibilityLabel={backLabel ?? "Back"} onPress={onBack} style={styles.backButton} hitSlop={8}>
            <Icon name="back" color={colors.primary} size={24} />
            <Text style={styles.backText}>{backLabel ?? "Back"}</Text>
          </Pressable>
        ) : null}
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Body({ children, muted, style, selectable }: { children: ReactNode; muted?: boolean; style?: object; selectable?: boolean }) {
  return (
    <Text selectable={selectable} style={[styles.body, muted && { color: colors.muted }, style]}>
      {children}
    </Text>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.h2}>
      {children}
    </Text>
  );
}

export function Note({ icon, children, tone = "info" }: { icon: IconName; children: ReactNode; tone?: "info" | "warn" | "danger" }) {
  const c = tone === "warn" ? colors.warn : tone === "danger" ? colors.danger : colors.primary;
  return (
    <View style={[styles.note, { borderColor: c }]} accessible accessibilityRole="text">
      <Icon name={icon} color={c} size={22} />
      <Text style={[styles.body, { flex: 1, color: colors.ink }]}>{children}</Text>
    </View>
  );
}

/** Progress ring for a run. */
export function ProgressRing({ progress, size = 200, label }: { progress: number; size?: number; label: string }) {
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  return (
    <View
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center", alignSelf: "center" }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(p * 100) }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.primary}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - p)}
          strokeLinecap="round"
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      </Svg>
      <Text style={styles.ringText}>{Math.round(p * 100)}%</Text>
    </View>
  );
}

/** Signal bars 0..4 (null = unknown). */
export function SignalBars({ level, label }: { level: number | null; label: string }) {
  const w = 56;
  const h = 40;
  return (
    <View accessible accessibilityLabel={`${label}: ${level ?? "?"} / 4`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Svg width={w} height={h}>
        {[0, 1, 2, 3].map((i) => {
          const bh = ((i + 1) / 4) * h;
          return (
            <Rect key={i} x={i * 14} y={h - bh} width={10} height={bh} rx={2} fill={level != null && level > i ? colors.primary : colors.border} />
          );
        })}
      </Svg>
      <Text style={styles.body}>{level == null ? "?" : `${level}/4`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  backButton: { flexDirection: "row", alignItems: "center", minHeight: 48, alignSelf: "flex-start", gap: 4 },
  backText: { color: colors.primary, fontSize: 16, fontWeight: "600" },
  title: { fontSize: 24, fontWeight: "700", color: colors.ink },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, gap: 8, borderWidth: 1, borderColor: colors.border },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink, flexShrink: 1 },
  h2: { fontSize: 19, fontWeight: "700", color: colors.ink, marginTop: 4 },
  note: { flexDirection: "row", gap: 10, padding: 12, borderWidth: 2, borderRadius: 10, backgroundColor: colors.card, alignItems: "flex-start" },
  button: {
    minHeight: 48,
    minWidth: 48,
    borderRadius: 10,
    borderWidth: 2,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  bigButton: { minHeight: 96, borderRadius: 48, paddingHorizontal: 28 },
  buttonText: { fontSize: 17, fontWeight: "700", textAlign: "center", flexShrink: 1 },
  bigButtonText: { fontSize: 24 },
  ringText: { fontSize: 32, fontWeight: "700", color: colors.ink },
});
