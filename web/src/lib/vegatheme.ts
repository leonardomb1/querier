// Vega-Lite's look, from the app's own tokens: our fonts, ink, hairlines and
// the validated categorical palette (fixed order, light and dark steps), so a
// chart from Altair, matplotlib's neighbours and the tables read as one system.

import type { Config } from "vega-lite";

// the dataviz reference palette: slot order is the colour-blind-safety mechanism
const CATEGORICAL = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const SEQUENTIAL = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

export function isDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme) return theme === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export function vegaConfig(): Config {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const font = v("--sans");
  const ink = v("--ink");
  const ink2 = v("--ink-2");
  const muted = v("--muted");
  const grid = v("--grid");
  const axis = v("--axis");
  const dark = isDark();
  const size = parseFloat(css.fontSize) || 16;
  const px = (rem: number) => Math.round(rem * size * 10) / 10;
  return {
    background: "transparent",
    font,
    padding: 4,
    view: { stroke: "transparent" },
    title: { color: ink, fontSize: px(0.875), fontWeight: 600, anchor: "start", offset: 12 },
    axis: {
      labelColor: muted,
      titleColor: ink2,
      labelFontSize: px(0.72),
      titleFontSize: px(0.75),
      titleFontWeight: 500,
      gridColor: grid,
      gridWidth: 1,
      domainColor: axis,
      tickColor: axis,
      tickSize: 4,
      labelPadding: 6,
      titlePadding: 10,
    },
    axisY: { domain: false, ticks: false },
    legend: {
      labelColor: ink2,
      titleColor: ink2,
      labelFontSize: px(0.75),
      titleFontSize: px(0.75),
      titleFontWeight: 500,
      symbolType: "circle",
      symbolSize: 80,
      orient: "top",
      direction: "horizontal",
    },
    header: { labelColor: ink2, titleColor: ink2, labelFontSize: px(0.75) },
    range: { category: dark ? CATEGORICAL.dark : CATEGORICAL.light, ramp: SEQUENTIAL, heatmap: SEQUENTIAL },
    line: { strokeWidth: 2, strokeCap: "round", strokeJoin: "round" },
    point: { size: 64, filled: true },
    bar: { cornerRadiusEnd: 4, continuousBandSize: 24, discreteBandSize: { band: 0.7 } },
    area: { opacity: 0.12, line: true },
    arc: { stroke: v("--surface"), strokeWidth: 2 },
    rect: { stroke: "transparent" },
    text: { color: ink2, font },
    mark: { color: dark ? CATEGORICAL.dark[0] : CATEGORICAL.light[0] },
  } as Config;
}

/** A log axis ticks, and grids, every 1–9 of each decade by default: a dense
 *  comb of lines. With a small tick count it keeps the powers of ten. A spec's
 *  own axis settings win. Walks layers, concats, facets and repeats. */
export function tidyLogAxes(spec: any): void {
  if (!spec || typeof spec !== "object") return;
  for (const ch of ["x", "y"]) {
    const e = spec.encoding?.[ch];
    if (e?.scale?.type !== "log" || e.axis === null) continue;
    e.axis = { ...(e.axis ?? {}) };
    e.axis.tickCount ??= 6;
  }
  for (const k of ["layer", "hconcat", "vconcat", "concat"]) if (Array.isArray(spec[k])) spec[k].forEach(tidyLogAxes);
  if (spec.spec) tidyLogAxes(spec.spec);
}
