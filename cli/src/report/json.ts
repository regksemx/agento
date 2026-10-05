// Stable JSON: fixed key order (matching docs/audit-schema.json), 2-space indent, no trailing newline.

import type { AuditReport } from '../types.ts';

type Obj = Record<string, unknown>;

// Known keys first in the given order, then any unknown ones alphabetically.
function ordered(o: unknown, keys: readonly string[], nested: Record<string, (v: unknown) => unknown> = {}): unknown {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return o;
  const src = o as Obj;
  const out: Obj = {};
  for (const k of keys) if (k in src && src[k] !== undefined) out[k] = nested[k] ? nested[k]!(src[k]) : src[k];
  for (const k of Object.keys(src).sort()) if (!(k in out) && src[k] !== undefined) out[k] = src[k];
  return out;
}

const list = (f: (v: unknown) => unknown) => (v: unknown) => (Array.isArray(v) ? v.map(f) : v);
const obj = (keys: readonly string[], nested?: Record<string, (v: unknown) => unknown>) => (v: unknown) => ordered(v, keys, nested);

const COST = ['input', 'cacheWrite', 'cacheRead', 'output', 'total'] as const;
const MONEY = ['usd', 'kind'] as const;

const SHAPE = obj(
  ['meta', 'spend', 'cache', 'ttl', 'tasks', 'subagents', 'deadContext', 'setup', 'switchSim', 'actions'],
  {
    meta: obj(['generatedAt', 'dir', 'since', 'sessions', 'files', 'calls', 'duplicateRowsDropped', 'badLines', 'unknownModelCalls', 'days', 'pricesAsOf', 'plan', 'lang']),
    spend: obj(
      ['total', 'main', 'subagents', 'byFamily', 'byProject', 'byDay', 'byWeek', 'fastModeCost', 'effortMix', 'reconciliation'],
      {
        total: obj(COST),
        main: obj(COST),
        subagents: obj(COST),
        byFamily: list(obj(['family', 'calls', 'cost'], { cost: obj(COST) })),
        byProject: list(obj(['project', 'cost', 'sessions'])),
        byDay: list(obj(['date', 'cost'])),
        byWeek: list(obj(['weekStart', 'cost'])),
        effortMix: list(obj(['effort', 'calls', 'cost'])),
        reconciliation: obj(['sessionsChecked', 'withinTolerance', 'medianDeviation', 'worstDeviation']),
      },
    ),
    cache: obj(['hitRatio', 'rewriteCost', 'losses'], { losses: list(obj(['cause', 'events', 'cost'])) }),
    ttl: obj(['observed', 'gapHistogram', 'recommendation'], {
      gapHistogram: list(obj(['label', 'count'])),
      recommendation: obj(['ttl', 'monthlySaving', 'reason'], { monthlySaving: obj(MONEY) }),
    }),
    tasks: obj(['count', 'light', 'lightOnExpensive', 'maxEffortOnLight', 'topExamples'], {
      lightOnExpensive: obj(['count', 'cost', 'asSonnet']),
      topExamples: list(
        obj(['sessionId', 'startTs', 'endTs', 'model', 'effort', 'mainCalls', 'filesEdited', 'outputTokens', 'errors', 'cost', 'isLight', 'firstPrompt']),
      ),
    }),
    subagents: obj(['share', 'calls', 'cost', 'byFamily', 'byType', 'haikuCandidates', 'sonnetCandidates'], {
      byFamily: list(obj(['family', 'cost'])),
      byType: list(obj(['type', 'calls', 'cost'])),
      haikuCandidates: obj(['count', 'cost', 'asHaiku']),
      sonnetCandidates: obj(['count', 'cost', 'asSonnet']),
    }),
    deadContext: obj(['events', 'cost']),
    setup: obj(['avgFixedPrefixTokens', 'fixedPrefixCost', 'claudeMd'], { claudeMd: list(obj(['path', 'bytes', 'tokens', 'monthlyReadCost', 'trimSaving'])) }),
    switchSim: obj(['rows'], {
      rows: list(obj(['from', 'to', 'prefixTokens', 'penalty', 'savingPerStep', 'breakEvenSteps'])),
    }),
    actions: list(obj(['id', 'title', 'detail', 'monthly'], { monthly: obj(MONEY) })),
  },
);

// Float noise from analyzers is not part of the contract.
const round = (_k: string, v: unknown): unknown => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);

export function renderJson(r: AuditReport): string {
  return JSON.stringify(SHAPE(r), round, 2);
}
