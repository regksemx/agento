// Which tasks to show. Deterministic for a given seed and a given set of unlabeled tasks.

import type { TaskRecord } from '../types.ts';
import type { L1Guess } from './types.ts';

export type Strategy = 'stratified' | 'disagreement' | 'random';
export const STRATEGIES: readonly Strategy[] = ['stratified', 'disagreement', 'random'];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Cost quartile edges over ALL own tasks (not only the unlabeled ones), so a task keeps its stratum while labeling goes on.
export function costEdges(tasks: readonly TaskRecord[]): [number, number, number] {
  const c = tasks.map((t) => t.observed.cost).sort((a, b) => a - b);
  const at = (q: number): number => (c.length === 0 ? 0 : c[Math.min(c.length - 1, Math.floor(q * c.length))]!);
  return [at(0.25), at(0.5), at(0.75)];
}

export function costQuartile(cost: number, edges: readonly [number, number, number]): 0 | 1 | 2 | 3 {
  return cost < edges[0] ? 0 : cost < edges[1] ? 1 : cost < edges[2] ? 2 : 3;
}

export function stratumKey(t: TaskRecord, edges: readonly [number, number, number]): string {
  return `${t.observed.modelTier}|${t.l0Tier}|q${costQuartile(t.observed.cost, edges)}`;
}

// 0 = everybody agrees on tier and effort; tier disagreement weighs double.
export function disagreementScore(t: TaskRecord, l1?: L1Guess): number {
  const tiers = new Set([t.l0Tier, t.rulesVerdict.tier, ...(l1 ? [l1.tier] : [])]);
  const efforts = new Set([t.l0Effort, t.rulesVerdict.effort, ...(l1 ? [l1.effort] : [])]);
  return (tiers.size - 1) * 2 + (efforts.size > 1 ? 1 : 0);
}

export interface SampleOptions {
  n: number;
  strategy: Strategy;
  seed: number;
  labeled: ReadonlySet<string>;
  l1?: ReadonlyMap<string, L1Guess>;
}

export function sampleTasks(tasks: readonly TaskRecord[], o: SampleOptions): TaskRecord[] {
  const byId = (a: TaskRecord, b: TaskRecord): number => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  const pool = tasks.filter((t) => !o.labeled.has(t.taskId) && t.text.length > 0).sort(byId);
  const n = Math.max(0, Math.min(o.n, pool.length));
  const rnd = mulberry32(o.seed);

  if (o.strategy === 'random') return shuffled(pool, rnd).slice(0, n);

  if (o.strategy === 'disagreement') {
    const scored = shuffled(pool, rnd)
      .map((t, i) => ({ t, i, s: disagreementScore(t, o.l1?.get(t.taskId)) }))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    // the order shown is shuffled again: the first cards must not all be the "obviously contested" ones
    return shuffled(scored.slice(0, n).map((x) => x.t), rnd);
  }

  // stratified: model x l0Tier x cost quartile cells, visited round-robin so every observed cell shows up before any repeats
  const edges = costEdges(tasks);
  const cells = new Map<string, TaskRecord[]>();
  for (const t of pool) {
    const k = stratumKey(t, edges);
    const cell = cells.get(k);
    if (cell) cell.push(t);
    else cells.set(k, [t]);
  }
  const keys = shuffled([...cells.keys()].sort(), rnd);
  const queues = keys.map((k) => shuffled(cells.get(k)!, rnd));
  const out: TaskRecord[] = [];
  while (out.length < n) {
    let took = false;
    for (const q of queues) {
      const t = q.shift();
      if (!t) continue;
      out.push(t);
      took = true;
      if (out.length >= n) break;
    }
    if (!took) break;
  }
  return out;
}
