// A handful of stroke icons drawn with react-native-svg (no icon font: saves several MB of APK).
import Svg, { Circle, Path, Rect } from "react-native-svg";

export type IconName =
  | "play"
  | "stop"
  | "pin"
  | "search"
  | "list"
  | "info"
  | "check"
  | "sync"
  | "trash"
  | "back"
  | "globe"
  | "speaker"
  | "refresh"
  | "alert";

export function Icon({ name, size = 24, color = "#fff" }: { name: IconName; size?: number; color?: string }) {
  const p = { stroke: color, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {name === "play" && <Path d="M7 4l13 8-13 8z" {...p} fill={color} />}
      {name === "stop" && <Rect x={6} y={6} width={12} height={12} {...p} fill={color} />}
      {name === "pin" && (
        <>
          <Path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z" {...p} />
          <Circle cx={12} cy={10} r={2.5} {...p} />
        </>
      )}
      {name === "search" && (
        <>
          <Circle cx={11} cy={11} r={6.5} {...p} />
          <Path d="M16 16l5 5" {...p} />
        </>
      )}
      {name === "list" && <Path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" {...p} />}
      {name === "info" && (
        <>
          <Circle cx={12} cy={12} r={9} {...p} />
          <Path d="M12 11v6M12 7.5v.01" {...p} />
        </>
      )}
      {name === "check" && <Path d="M4 12.5l5 5L20 6.5" {...p} />}
      {name === "sync" && <Path d="M20 12a8 8 0 01-14.3 4.9M4 12A8 8 0 0118.3 7.1M18.5 3v4.3h-4.3M5.5 21v-4.3h4.3" {...p} />}
      {name === "refresh" && <Path d="M20 12a8 8 0 11-2.4-5.7M20 4v5h-5" {...p} />}
      {name === "trash" && <Path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" {...p} />}
      {name === "back" && <Path d="M15 5l-7 7 7 7" {...p} />}
      {name === "globe" && (
        <>
          <Circle cx={12} cy={12} r={9} {...p} />
          <Path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" {...p} />
        </>
      )}
      {name === "speaker" && <Path d="M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" {...p} />}
      {name === "alert" && <Path d="M12 3l10 18H2L12 3zM12 10v5M12 18v.01" {...p} />}
    </Svg>
  );
}
