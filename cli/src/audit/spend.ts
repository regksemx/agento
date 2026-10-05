import { addCost, costOf, ZERO_COST, type CostBreakdown } from '../../../plugin/core/cost.ts';
import { familyOf, type ModelFamily } from '../../../plugin/core/pricing.ts';
import { tildify } from '../report/format.ts';
import type { ApiCall, Corpus, SessionData, SpendSection } from '../types.ts';

export const RECONCILE_TOLERANCE = 0.1;
export const RECONCILE_MIN_REPORTED_USD = 0.05; // below this the reported cost is mostly rounding noise

// Cost of one call at list prices; null for unknown models. Fast mode is read from the call as well as from usage.
export function callCost(c: ApiCall): CostBreakdown | null {
  const speed = c.speed ?? c.usage.speed;
  return costOf(c.model, speed === c.usage.speed ? c.usage : { ...c.usage, speed });
}

export function sessionCost(s: SessionData): number {
  let sum = 0;
  for (const c of s.calls) sum += callCost(c)?.total ?? 0;
  return sum;
}

// Compares our price-list total with the `totalCostUSD` Claude Code itself recorded (last cost-state row).
export function reconcile(sessions: SessionData[], tolerance = RECONCILE_TOLERANCE): SpendSection['reconciliation'] {
  const deviations: number[] = [];
  let withinTolerance = 0;
  for (const s of sessions) {
    const reported = s.reportedCostUSD;
    // Sessions whose requests all live in another file (resumed copies) have nothing to compare; tiny ones are noise.
    if (reported === undefined || !(reported >= RECONCILE_MIN_REPORTED_USD) || s.calls.length === 0) continue;
    const deviation = Math.abs(sessionCost(s) - reported) / reported;
    deviations.push(deviation);
    if (deviation <= tolerance) withinTolerance++;
  }
  deviations.sort((a, b) => a - b);
  const mid = deviations.length >> 1;
  const medianDeviation = deviations.length === 0 ? 0 : deviations.length % 2 ? deviations[mid]! : (deviations[mid - 1]! + deviations[mid]!) / 2;
  return { sessionsChecked: deviations.length, withinTolerance, medianDeviation, worstDeviation: deviations[deviations.length - 1] ?? 0 };
}

// A project directory is named after its cwd with `/` turned into `-` (lossy for names with dashes): fallback label only.
function decodeProjectDir(dir: string): string {
  return tildify(dir.startsWith('-') ? dir.replace(/-/g, '/') : dir);
}

// Project label: the most common session cwd of the project directory, home shown as `~`.
function projectLabels(sessions: SessionData[]): Map<string, string> {
  const cwds = new Map<string, Map<string, number>>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const m = cwds.get(s.project) ?? new Map<string, number>();
    m.set(s.cwd, (m.get(s.cwd) ?? 0) + 1);
    cwds.set(s.project, m);
  }
  const labels = new Map<string, string>();
  for (const [dir, m] of cwds) {
    let best = '';
    let bestN = 0;
    for (const [cwd, n] of m) if (n > bestN || (n === bestN && cwd < best)) ((best = cwd), (bestN = n));
    labels.set(dir, tildify(best));
  }
  return labels;
}

// Calendar days from the first to the last request, at least 1: what "per month" figures are scaled by.
export function coveredDays(c: Corpus): number {
  let first = Infinity;
  let last = -Infinity;
  for (const s of c.sessions) {
    if (s.calls.length === 0) continue;
    first = Math.min(first, s.firstTs);
    last = Math.max(last, s.lastTs);
  }
  if (!Number.isFinite(first)) return 1;
  return Math.max(1, Math.ceil((last - first) / 86_400_000));
}

export function analyzeSpend(c: Corpus): SpendSection {
  let total = ZERO_COST;
  let main = ZERO_COST;
  let subagents = ZERO_COST;
  let fastModeCost = 0;
  const families = new Map<ModelFamily, { calls: number; cost: CostBreakdown }>();
  const projects = new Map<string, { cost: number; sessions: Set<string> }>();
  const efforts = new Map<string, { calls: number; cost: number }>();
  const labels = projectLabels(c.sessions);
  const days = new Map<string, number>();

  for (const s of c.sessions) {
    for (const call of s.calls) {
      const cost = callCost(call) ?? ZERO_COST;
      total = addCost(total, cost);
      if (call.lineage === 'main') main = addCost(main, cost);
      else subagents = addCost(subagents, cost);
      if ((call.speed ?? call.usage.speed) === 'fast') fastModeCost += cost.total;

      const family = familyOf(call.model);
      const f = families.get(family) ?? { calls: 0, cost: ZERO_COST };
      families.set(family, { calls: f.calls + 1, cost: addCost(f.cost, cost) });

      const label = labels.get(call.project) ?? decodeProjectDir(call.project);
      const p = projects.get(label) ?? { cost: 0, sessions: new Set<string>() };
      p.cost += cost.total;
      p.sessions.add(call.sessionId);
      projects.set(label, p);

      const effort = call.effort ?? 'unknown';
      const e = efforts.get(effort) ?? { calls: 0, cost: 0 };
      efforts.set(effort, { calls: e.calls + 1, cost: e.cost + cost.total });

      const day = localDate(call.ts);
      days.set(day, (days.get(day) ?? 0) + cost.total);
    }
  }

  return {
    total,
    main,
    subagents,
    byFamily: [...families].map(([family, v]) => ({ family, calls: v.calls, cost: v.cost })).sort((a, b) => b.cost.total - a.cost.total),
    byProject: [...projects].map(([project, v]) => ({ project, cost: v.cost, sessions: v.sessions.size })).sort((a, b) => b.cost - a.cost),
    byDay: fillDays(days),
    byWeek: weeksOf(days),
    fastModeCost,
    effortMix: [...efforts].map(([effort, v]) => ({ effort, ...v })).sort((a, b) => b.cost - a.cost),
    reconciliation: reconcile(c.sessions),
  };
}

// ───────────────────────── local-time calendar ─────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

// Every `step` days from the first to the last key, gaps filled with 0.
function fill(costs: Map<string, number>, step: number): Array<[string, number]> {
  const keys = [...costs.keys()].sort();
  const out: Array<[string, number]> = [];
  if (keys.length === 0) return out;
  const end = keys[keys.length - 1]!;
  let d = parseDate(keys[0]!);
  for (let key = localDate(d.getTime()); key <= end; key = localDate(d.getTime())) {
    out.push([key, costs.get(key) ?? 0]);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
  }
  return out;
}

function fillDays(days: Map<string, number>): Array<{ date: string; cost: number }> {
  return fill(days, 1).map(([date, cost]) => ({ date, cost }));
}

// Weeks start on Monday.
function weeksOf(days: Map<string, number>): Array<{ weekStart: string; cost: number }> {
  const byWeek = new Map<string, number>();
  for (const [day, cost] of days) {
    const d = parseDate(day);
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const key = localDate(monday.getTime());
    byWeek.set(key, (byWeek.get(key) ?? 0) + cost);
  }
  return fill(byWeek, 7).map(([weekStart, cost]) => ({ weekStart, cost }));
}
