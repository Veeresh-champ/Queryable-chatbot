import { createTheme } from "@openuidev/react-ui";

/**
 * Queryable Chatbot tokens for OpenUI's ThemeProvider (passed through
 * <AgentInterface theme={...}>). Surfaces are translucent warm onyx so the
 * cinematic aurora backdrop glows through; the brand accent is champagne gold
 * with a rose-copper counterpoint and a deep burgundy aurora ("Onyx &
 * Champagne"). Matching CSS variables live in globals.css (--qc-*), so custom
 * chrome and OpenUI share one palette.
 *
 * Chart palettes: eight distinct, jewel-toned hues (champagne, copper,
 * jade, garnet, steel blue, brass, orchid, olive) ordered so neighbours never
 * share a family. The light set is one step deeper so every hue holds against
 * ivory.
 */
const DARK_SERIES = ["#e6c47a", "#e8836b", "#7fc8b6", "#c56b8a", "#8fb3e0", "#b9a36c", "#d9a5c9", "#9cc178"];
const LIGHT_SERIES = ["#9a6b12", "#c2410c", "#0f766e", "#9f1239", "#2f5f9e", "#7a6a3a", "#a2457f", "#4d7c0f"];

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
  foreground: "rgba(24, 21, 17, 0.74)",
  popoverBackground: "#17140f",
  sunkLight: "rgba(255, 240, 210, 0.02)",
  sunk: "rgba(10, 9, 7, 0.66)",
  sunkDeep: "rgba(0, 0, 0, 0.4)",
  elevatedLight: "rgba(32, 28, 22, 0.72)",
  elevated: "rgba(38, 33, 26, 0.86)",
  elevatedStrong: "rgba(50, 43, 33, 0.92)",
  highlightSubtle: "rgba(255, 236, 200, 0.03)",
  highlight: "rgba(255, 236, 200, 0.06)",
  highlightStrong: "rgba(255, 236, 200, 0.1)",
  textNeutralPrimary: "#f7f1e6",
  textNeutralSecondary: "#c9bfae",
  textNeutralTertiary: "#8f8574",
  textNeutralLink: "#f2d79b",
  textBrand: "#e6c47a",
  textAccentPrimary: "#1a1206",
  interactiveAccentDefault: "#e6c47a",
  interactiveAccentHover: "#f2d79b",
  interactiveAccentPressed: "#c9973f",
  borderDefault: "rgba(230, 196, 122, 0.09)",
  borderInteractive: "rgba(230, 196, 122, 0.15)",
  borderInteractiveEmphasis: "rgba(230, 196, 122, 0.3)",
  borderAccent: "rgba(230, 196, 122, 0.55)",
  chatUserResponseBg: "rgba(230, 196, 122, 0.14)",
  chatUserResponseText: "#fbf5ea",
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
  highlightSubtle: "rgba(90, 64, 20, 0.025)",
  highlight: "rgba(90, 64, 20, 0.05)",
  highlightStrong: "rgba(90, 64, 20, 0.09)",
  textNeutralPrimary: "#1c1710",
  textNeutralSecondary: "#5a4f40",
  textNeutralTertiary: "#8a7f6d",
  textNeutralLink: "#9a6b12",
  textBrand: "#9a6b12",
  textAccentPrimary: "#ffffff",
  interactiveAccentDefault: "#9a6b12",
  interactiveAccentHover: "#7d560c",
  interactiveAccentPressed: "#664608",
  borderDefault: "rgba(90, 64, 20, 0.09)",
  borderInteractive: "rgba(90, 64, 20, 0.14)",
  borderInteractiveEmphasis: "rgba(90, 64, 20, 0.26)",
  borderAccent: "rgba(154, 107, 18, 0.45)",
  chatUserResponseBg: "rgba(154, 107, 18, 0.1)",
  chatUserResponseText: "#1c1710",
});
