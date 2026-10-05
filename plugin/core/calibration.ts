// Subscription calibration (spec §7.8): how many percent of the weekly limit one API-equivalent dollar costs
// this user. Public documents do not say how the limit weighs models, so this is an empirical estimate,
// fitted from pairs the ledger records: (API-equivalent dollars spent in a limit window, seven_day percent used).
// Pure TypeScript.

export interface CalibrationPoint {
  usd: number;
  pct: number;
}

// One weekly limit window: its reset time identifies it, the dollars accumulate across sessions.
export interface CalibrationWindow {
  resetsAt: string;
  usd: number;
  points: CalibrationPoint[];
}

export const CALIBRATION_KEY = 'calibration';
export const MAX_POINTS = 120;
// A fit needs at least this much evidence, otherwise the percent is not shown at all.
export const MIN_POINTS = 5;
export const MIN_USD_SPAN = 1;
export const MIN_PCT_SPAN = 1;
const KEEP_WINDOWS = 4;

export interface CalibrationState {
  windows: CalibrationWindow[];
}

export function isCalibration(v: unknown): v is CalibrationState {
  return !!v && typeof v === 'object' && Array.isArray((v as CalibrationState).windows);
}

// Adds the dollars of one step to the window `resetsAt` and, when the percent moved, records a point.
export function recordStep(prev: unknown, resetsAt: string, usd: number, pct: number | null): CalibrationState {
  const windows = isCalibration(prev) ? prev.windows.map((w) => ({ ...w, points: [...w.points] })) : [];
  let w = windows.find((x) => x.resetsAt === resetsAt);
  if (!w) {
    w = { resetsAt, usd: 0, points: [] };
    windows.push(w);
  }
  w.usd += usd;
  if (pct !== null) {
    const last = w.points[w.points.length - 1];
    if (!last || last.pct !== pct) w.points.push({ usd: w.usd, pct });
    if (w.points.length > MAX_POINTS) w.points = w.points.slice(-MAX_POINTS);
  }
  return { windows: windows.slice(-KEEP_WINDOWS) };
}

// Pooled least squares through each window's own origin (a window starts at 0 % and $0 spent on it by this
// plugin: the intercept is the usage of other clients, so each window is centred on its own mean).
// Returns percent of the weekly limit per dollar, or null without enough evidence.
export function fitPctPerUsd(state: CalibrationState | undefined): number | null {
  if (!state) return null;
  let sxy = 0;
  let sxx = 0;
  let n = 0;
  let usdSpan = 0;
  let pctSpan = 0;
  for (const w of state.windows) {
    if (w.points.length < 2) continue;
    const mx = w.points.reduce((a, p) => a + p.usd, 0) / w.points.length;
    const my = w.points.reduce((a, p) => a + p.pct, 0) / w.points.length;
    for (const p of w.points) {
      sxy += (p.usd - mx) * (p.pct - my);
      sxx += (p.usd - mx) ** 2;
    }
    n += w.points.length;
    usdSpan += Math.max(...w.points.map((p) => p.usd)) - Math.min(...w.points.map((p) => p.usd));
    pctSpan += Math.max(...w.points.map((p) => p.pct)) - Math.min(...w.points.map((p) => p.pct));
  }
  if (n < MIN_POINTS || usdSpan < MIN_USD_SPAN || pctSpan < MIN_PCT_SPAN || sxx <= 0) return null;
  const slope = sxy / sxx;
  return slope > 0 && Number.isFinite(slope) ? slope : null;
}

// The weekly-limit share of `usd` API-equivalent dollars, or null without a calibration.
export function pctOf(usd: number, pctPerUsd: number | null): number | null {
  return pctPerUsd === null ? null : usd * pctPerUsd;
}
