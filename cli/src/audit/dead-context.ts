import { prefixTokens } from '../../../plugin/core/cost.ts';
import { priceOf } from '../../../plugin/core/pricing.ts';
import { topicShift } from '../../../plugin/core/task.ts';
import type { ApiCall, Corpus, DeadContextSection, SessionData } from '../types.ts';
import { taskStartPrompts } from './tasks.ts';

export const MIN_SHIFT = 0.85;
export const MIN_IDLE_MS = 10 * 60_000;
export const MIN_PREFIX_TOKENS = 60_000;

// A probable topic change inside a long warm context: the old prefix keeps being read on every later step
// of the task, although the new prompt has little to do with it.
function analyzeSession(s: SessionData): { events: number; cost: number } {
  const prompts = s.prompts.filter((p) => !p.isSlashCommand);
  const main = s.calls.filter((c) => c.lineage === 'main');
  const resets = s.markers.filter((m) => m.kind === 'compact' || m.kind === 'clear').map((m) => m.ts);
  const startTs = taskStartPrompts(s).map((p) => p.ts);
  let events = 0;
  let cost = 0;

  for (let i = 1; i < prompts.length; i += 1) {
    const prev = prompts[i - 1]!;
    const p = prompts[i]!;
    if (resets.some((t) => t > prev.ts && t <= p.ts)) continue; // the old context is already gone
    if (topicShift(prev.text, p.text) < MIN_SHIFT) continue;

    let last: ApiCall | undefined;
    for (const c of main) if (c.ts < p.ts) last = c;
    if (!last || p.ts - last.ts < MIN_IDLE_MS) continue;
    const old = prefixTokens(last.usage);
    if (old < MIN_PREFIX_TOKENS) continue;

    const end = Math.min(startTs.find((t) => t > p.ts) ?? Infinity, resets.find((t) => t > p.ts) ?? Infinity);
    const after = main.filter((c) => c.ts >= p.ts && c.ts < end);
    if (after.length === 0) continue;

    events += 1;
    for (const c of after) {
      const price = priceOf(c.model);
      if (price) cost += (Math.min(old, prefixTokens(c.usage)) * price.cacheRead) / 1_000_000;
    }
  }
  return { events, cost };
}

export function analyzeDeadContext(c: Corpus): DeadContextSection {
  let events = 0;
  let cost = 0;
  for (const s of c.sessions) {
    const r = analyzeSession(s);
    events += r.events;
    cost += r.cost;
  }
  return { events, cost };
}
