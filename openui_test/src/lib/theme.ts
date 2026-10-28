import { createTheme } from "@openuidev/react-ui";

/**
 * Queryable Chatbot tokens for OpenUI's ThemeProvider (passed through
 * <AgentInterface theme={...}>). Surfaces are translucent ink so the
 * cinematic aurora backdrop glows through; the brand accent is violet with a cyan counterpoint. Matching CSS
 * variables live in globals.css (--qc-*), so custom chrome and OpenUI
 * share one palette.
 *
 * Chart palettes: eight distinct hues (violet, cyan, amber, pink, emerald,
 * azure, orange, purple) ordered so neighbours never share a family. The
 * light set is one step deeper so every hue holds against white.
 */
const DARK_SERIES = ["#8b7bff", "#22d3ee", "#fbbf24", "#f472b6", "#34d399", "#60a5fa", "#fb923c", "#c084fc"];
const LIGHT_SERIES = ["#5b4bdb", "#0891b2", "#d97706", "#db2777", "#059669", "#2563eb", "#ea580c", "#9333ea"];

const palettes = (series: string[]) => ({
  defaultChartPalette: series,
  barChartPalette: series,
  lineChartPalette: series,
  areaChartPalette: series,
  pieChartPalette: series,
  radarChartPalette: series,
  radialChartPalette: series,
  horizontalBarChartPalette: series,
});

const typography = {
  fontBody: "var(--font-sans), system-ui, sans-serif",
  fontHeading: "var(--font-sans), system-ui, sans-serif",
  fontLabel: "var(--font-sans), system-ui, sans-serif",
  fontNumbers: "var(--font-sans), system-ui, sans-serif",
};

export const queryableDarkTheme = createTheme({
  ...palettes(DARK_SERIES),
  ...typography,
  // Translucent surfaces: the aurora backdrop (globals.css) shows through.
  background: "transparent",
  foreground: "rgba(14, 18, 38, 0.72)",
  popoverBackground: "#11162b",
  sunkLight: "rgba(255, 255, 255, 0.02)",
  sunk: "rgba(9, 12, 28, 0.66)",
  sunkDeep: "rgba(0, 0, 0, 0.4)",
  elevatedLight: "rgba(22, 28, 56, 0.7)",
  elevated: "rgba(26, 32, 62, 0.82)",
  elevatedStrong: "rgba(34, 41, 76, 0.9)",
  highlightSubtle: "rgba(255, 255, 255, 0.025)",
  highlight: "rgba(255, 255, 255, 0.06)",
  highlightStrong: "rgba(255, 255, 255, 0.1)",
  textNeutralPrimary: "#eef1ff",
  textNeutralSecondary: "#b4bad6",
  textNeutralTertiary: "#7d84a6",
  textNeutralLink: "#a99dff",
  textBrand: "#a99dff",
  textAccentPrimary: "#0b0820",
  interactiveAccentDefault: "#8b7bff",
  interactiveAccentHover: "#a99dff",
  interactiveAccentPressed: "#7462f0",
  borderDefault: "rgba(255, 255, 255, 0.07)",
  borderInteractive: "rgba(255, 255, 255, 0.12)",
  borderInteractiveEmphasis: "rgba(255, 255, 255, 0.22)",
  borderAccent: "rgba(139, 123, 255, 0.55)",
  chatUserResponseBg: "rgba(139, 123, 255, 0.16)",
  chatUserResponseText: "#f3f1ff",
});

export const queryableLightTheme = createTheme({
  ...palettes(LIGHT_SERIES),
  ...typography,
  background: "transparent",
  foreground: "rgba(255, 255, 255, 0.7)",
  popoverBackground: "#ffffff",
  sunkLight: "rgba(255, 255, 255, 0.5)",
  sunk: "rgba(255, 255, 255, 0.72)",
  elevated: "rgba(255, 255, 255, 0.9)",
  highlightSubtle: "rgba(30, 35, 90, 0.025)",
  highlight: "rgba(30, 35, 90, 0.05)",
  highlightStrong: "rgba(30, 35, 90, 0.09)",
  textNeutralPrimary: "#12152b",
  textNeutralSecondary: "#4a5072",
  textNeutralTertiary: "#7a809c",
  textNeutralLink: "#5b4bdb",
  textBrand: "#5b4bdb",
  textAccentPrimary: "#ffffff",
  interactiveAccentDefault: "#5b4bdb",
  interactiveAccentHover: "#4a3ac4",
  interactiveAccentPressed: "#3b2db0",
  borderDefault: "rgba(30, 35, 90, 0.08)",
  borderInteractive: "rgba(30, 35, 90, 0.13)",
  borderInteractiveEmphasis: "rgba(30, 35, 90, 0.24)",
  borderAccent: "rgba(91, 75, 219, 0.45)",
  chatUserResponseBg: "rgba(91, 75, 219, 0.1)",
  chatUserResponseText: "#1d1650",
});
