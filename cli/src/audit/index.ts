import { PRICES_AS_OF } from '../../../plugin/core/pricing.ts';
import type { AuditReport, Corpus } from '../types.ts';
import { analyzeSpend, coveredDays } from './spend.ts';
import { analyzeSubagents } from './subagents.ts';
import { analyzeCacheMisses } from './cache-misses.ts';
import { analyzeTtl } from './ttl.ts';
import { simulateSwitches } from './switch-sim.ts';
import { analyzeSetup } from './setup.ts';
import { analyzeTasks } from './tasks.ts';
import { analyzeDeadContext } from './dead-context.ts';
import { buildActions } from './actions.ts';

export interface AuditOptions {
  lang: 'ru' | 'en';
  since?: string;
  now?: number;
}

export function buildReport(c: Corpus, opts: AuditOptions): AuditReport {
  const sections = {
    spend: analyzeSpend(c),
    cache: analyzeCacheMisses(c),
    ttl: analyzeTtl(c, opts.now),
    tasks: analyzeTasks(c),
    subagents: analyzeSubagents(c),
    deadContext: analyzeDeadContext(c),
    setup: analyzeSetup(c, { days: coveredDays(c) }),
    switchSim: simulateSwitches(c),
  };
  const days = coveredDays(c);
  return {
    meta: {
      generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
      dir: c.dir,
      since: opts.since,
      sessions: c.sessions.length,
      files: c.stats.files,
      calls: c.sessions.reduce((n, s) => n + s.calls.length, 0),
      duplicateRowsDropped: c.stats.duplicateRows,
      badLines: c.stats.badLines,
      unknownModelCalls: c.stats.unknownModelCalls,
      days,
      pricesAsOf: PRICES_AS_OF,
      // Claude Code writes 1h cache entries on subscriptions and 5m on API keys by default.
      plan: sections.ttl.observed === '1h' ? 'subscription' : sections.ttl.observed === '5m' ? 'api' : 'unknown',
      lang: opts.lang,
    },
    ...sections,
    actions: buildActions(sections, days, opts.lang),
  };
}
