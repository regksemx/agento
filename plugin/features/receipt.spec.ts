import { describe, expect, it } from 'vitest';
import type { AgentoLedger, AgentoTaskBooks } from '../types';
import { emptyLedger } from './ledger.ts';
import { receiptBanner, taskShare } from './receipt.ts';
import { formatStatus } from './status.ts';

const books = (over: Partial<AgentoTaskBooks> = {}): AgentoTaskBooks => ({ class: 'default', tier: 'opus', cost: 0.8, steps: 9, total: 1.2, saved: {}, cheaper: {}, prunedTokens: 0, ...over });
const api = { lang: 'en' as const, isSubscription: false, pctPerUsd: null };
const sub = { lang: 'ru' as const, isSubscription: true, pctPerUsd: 0.5 };

describe('receiptBanner', () => {
  it('cost of the task and what saved it, by mechanism', () => {
    const b = receiptBanner({ books: books({ saved: { 'spawn-routing': 0.3, autopilot: 0.1 }, cheaper: { haiku: 3 } }), money: api, sevenDayPct: null });
    expect(b?.scenario).toBe('RC');
    expect(b?.title).toBe('This task cost $1.20');
    expect(b?.reason).toBe('agento saved ≈$0.40: autopilot picked a cheaper model, subagents: haiku ×3');
    expect(b?.estimate).toBe('cost measured, savings estimated');
    expect(b?.actions.map((a) => a.key)).toEqual(['details']);
  });
  it('nothing saved: says so plainly', () => {
    const b = receiptBanner({ books: books(), money: api, sevenDayPct: null });
    expect(b?.reason).toBe('agento changed nothing here');
    expect(b?.estimate).toBeNull();
  });
  it('a free task gets no receipt', () => {
    expect(receiptBanner({ books: books({ total: 0, cost: 0 }), money: api, sevenDayPct: null })).toBeNull();
  });
  it('subscriber: the limit movement when both readings exist, else the calibration', () => {
    expect(taskShare({ books: books({ sevenDayPctAtStart: 40 }), money: sub, sevenDayPct: 40.8 })).toBe('0.8% недели');
    expect(taskShare({ books: books(), money: sub, sevenDayPct: 41 })).toBe('0.6% недели');
    const b = receiptBanner({ books: books({ saved: { prune: 0.2 }, prunedTokens: 12_000 }), money: sub, sevenDayPct: null });
    expect(b?.title).toBe('Задача обошлась в 0.6% недели');
    expect(b?.reason).toBe('agento сэкономил ≈0.1% недели: убраны старые выводы (−12k токенов)');
  });
});

describe('formatStatus', () => {
  const l = (over: Partial<AgentoLedger> = {}): AgentoLedger => ({ ...emptyLedger(0, 'balanced', false), cost: 1.84, ...over });
  it('API key: session spend, task, savings', () => {
    expect(formatStatus(l(), api, 0.31, 0.4)).toBe('$1.84 · task $0.31 · saved ≈$0.40');
    expect(formatStatus(l(), api, null, 0)).toBe('$1.84');
  });
  it('subscriber: the 7-day limit first, amounts as a share of the week', () => {
    expect(formatStatus(l({ isSubscription: true, sevenDayPct: 63.4 }), { ...sub, pctPerUsd: 2 }, 0.2, 0.6)).toBe('7д 63% · задача 0.4% · сэкономлено ≈1.2%');
  });
});
