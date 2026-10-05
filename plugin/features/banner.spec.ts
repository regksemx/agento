import { describe, expect, it } from 'vitest';
import type { LoopSignal } from '../core/loop-guard.ts';
import type { TaskVerdict } from '../core/task.ts';
import { agentHint, autopilotBanner, autopilotToast, costLine, reasonsText, s1Banner, s2aBanner, s2bBanner, s4Banner, s7Banner, savingLine, type MoneyCtx } from './banner.ts';

const API: MoneyCtx = { lang: 'ru', isSubscription: false, pctPerUsd: null };
const SUB_CAL: MoneyCtx = { lang: 'ru', isSubscription: true, pctPerUsd: 2 };
const SUB: MoneyCtx = { lang: 'en', isSubscription: true, pctPerUsd: null };
const EN: MoneyCtx = { lang: 'en', isSubscription: false, pctPerUsd: null };

const verdict: TaskVerdict = { tier: 'sonnet', effort: 'medium', confidence: 0.7, reasons: ['light keywords: 2', 'short prompt: 25 chars'] };
const cur = { model: 'claude-opus-5-5', effort: 'high' };

describe('how an estimate is phrased (spec §7.8, P6)', () => {
  it('API account: dollars, marked as an estimate', () => {
    expect(savingLine(0.4, 'default', API)).toBe('≈ −$0.40 на такой задаче · оценка');
    expect(savingLine(0.4, 'history', EN)).toBe('≈ −$0.40 on a task like this · estimate from your tasks');
  });
  it('subscriber with a calibration: percent of the weekly limit', () => {
    expect(savingLine(0.3, 'default', SUB_CAL)).toBe('≈ −0.6% недельного лимита на такой задаче · оценка');
    expect(savingLine(0.001, 'default', SUB_CAL)).toContain('<0.1%');
  });
  it('subscriber without a calibration: API-equivalent dollars, said so', () => {
    expect(savingLine(0.4, 'default', SUB)).toBe('≈ −$0.40 API-equivalent on a task like this · estimate');
  });
  it('no figure when there is nothing to say', () => {
    expect(savingLine(null, null, API)).toBeNull();
    expect(savingLine(0, 'default', API)).toBeNull();
    expect(costLine(null, API)).toBeNull();
  });
  it('a running cost is per step', () => {
    expect(costLine(0.065, EN)).toBe('≈ $0.07 per step · estimate');
    expect(costLine(0.1, SUB_CAL)).toBe('≈ 0.2% недельного лимита за шаг · оценка');
  });
});

describe('S1 banner', () => {
  const b = s1Banner({ down: { model: 'sonnet', effort: 'medium' }, verdict, current: cur, saving: { usd: 0.18, basis: 'default' }, money: API });
  it('has a reason and an estimate (P4)', () => {
    expect(b.scenario).toBe('S1');
    expect(b.title).toBe('Похоже на лёгкую задачу');
    expect(b.reason).toContain('sonnet·medium');
    expect(b.reason).toContain('opus·high');
    expect(b.reason).toContain('слова лёгкой задачи ×2');
    expect(b.estimate).toBe('≈ −$0.18 на такой задаче · оценка');
  });
  it('buttons: the model, the effort, keep, don\'t suggest', () => {
    expect(b.actions.map((a) => [a.key, a.label])).toEqual([['model', 'Sonnet'], ['effort', 'Effort medium'], ['keep', 'Оставить'], ['never', 'Не предлагать']]);
    expect(b.data).toMatchObject({ model: 'sonnet', effort: 'medium', fromModel: 'claude-opus-5-5', fromEffort: 'high' });
  });
  it('effort only: no model button, and it says why there is no dollar figure', () => {
    const e = s1Banner({ down: { effort: 'medium' }, verdict, current: { model: 'claude-sonnet-5-5', effort: 'max' }, saving: null, money: EN });
    expect(e.actions.map((a) => a.key)).toEqual(['effort', 'keep', 'never']);
    expect(e.estimate).toContain('no estimate');
    expect(e.title).toBe('Effort is higher than this task needs');
  });
  it('english', () => {
    const e = s1Banner({ down: { model: 'sonnet' }, verdict, current: cur, saving: { usd: 0.18, basis: 'ratio' }, money: EN });
    expect(e.title).toBe('Looks like a light task');
    expect(e.actions.at(-1)?.label).toBe("Don't suggest");
  });
});

describe('autopilot notice', () => {
  it('can be undone and switched off, and says what it did and why', () => {
    const i = { down: { model: 'sonnet', effort: 'medium' as const }, verdict, current: cur, saving: { usd: 0.18, basis: 'default' as const }, money: API };
    const b = autopilotBanner(i);
    expect(b.scenario).toBe('AP');
    expect(b.title).toBe('agento: sonnet·medium для этой задачи');
    expect(b.reason).toContain('было opus·high');
    expect(b.actions.map((a) => a.key)).toEqual(['undo', 'disable', 'ok']);
    expect(b.actions[0]?.label).toBe('Вернуть opus·high');
    expect(autopilotToast(i)).toContain('sonnet·medium для этой задачи (было opus·high)');
  });
  it('the undo button names only what changed', () => {
    const m = autopilotBanner({ down: { model: 'sonnet' }, verdict, current: cur, saving: null, money: API });
    expect(m.actions[0]?.label).toBe('Вернуть opus');
    const e = autopilotBanner({ down: { effort: 'medium' }, verdict, current: cur, saving: null, money: EN });
    expect(e.actions[0]?.label).toBe('Back to effort high');
  });
});

describe('S2 banners', () => {
  it('discuss with opus: names the setup, offers the way in, can be silenced', () => {
    const b = s2aBanner({ verdict: { tier: 'opus', effort: 'high', confidence: 0.6, reasons: ['heavy keywords: 2'] }, current: { model: 'claude-sonnet-5-5', effort: 'medium' }, stepExtraUsd: 0.0225, money: API });
    expect(b.scenario).toBe('S2a');
    expect(b.title).toContain('sonnet·medium');
    expect(b.actions.map((a) => a.key)).toEqual(['discuss', 'no', 'never']);
    expect(b.actions[0]?.label).toBe('Обсудить архитектуру с Opus (plan mode)');
    expect(b.estimate).toContain('$0.02');
    expect(b.reason).toContain('слова про архитектуру/сложность ×2');
  });
  it('plan approved: the orchestra button exists only when orchestrator mode is on', () => {
    const off = s2bBanner({ plan: '# p', plannerTokens: 142_000, savingUsd: 0.7, orchestrate: false, money: API });
    const on = s2bBanner({ plan: '# p', plannerTokens: 142_000, savingUsd: 0.7, orchestrate: true, money: API });
    expect(off.actions.map((a) => a.key)).toEqual(['handoff', 'continue', 'never']);
    expect(on.actions.map((a) => a.key)).toEqual(['handoff', 'continue', 'orchestra', 'never']);
    expect(off.actions[0]?.label).toBe('Писать код на Sonnet — чистый контекст');
    expect(off.reason).toContain('142k');
    expect(off.estimate).toContain('$0.70');
    expect(off.data.plan).toBe('# p');
  });
});

describe('S4 banner', () => {
  it('quotes the per-step cost of the old context and offers clear / compact / keep', () => {
    const b = s4Banner({ why: 'topic-shift', contextTokens: 120_000, perStepUsd: 0.024, taskSavingUsd: 0.36, prompt: 'new topic', money: API });
    expect(b.title).toBe('Новая тема в длинном контексте');
    expect(b.reason).toContain('120k');
    expect(b.reason).toContain('$0.02/шаг');
    expect(b.estimate).toBe('≈ −$0.36 на такой задаче · оценка');
    expect(b.actions.map((a) => a.key)).toEqual(['clear', 'compact', 'keep', 'never']);
    expect(b.data.prompt).toBe('new topic');
  });
  it('titles by reason', () => {
    expect(s4Banner({ why: 'big-context', contextTokens: 160_000, perStepUsd: null, taskSavingUsd: null, prompt: '', money: EN }).title).toBe('The context grew to 160k');
    expect(s4Banner({ why: 'new-task', contextTokens: 90_000, perStepUsd: null, taskSavingUsd: null, prompt: '', money: EN }).title).toBe('New task in a long context');
  });
});

describe('S7 banner', () => {
  const sig: LoopSignal = { kind: 'failing-test', count: 3, detail: 'npx vitest run auth.spec' };
  it('stop, hint, continue', () => {
    const b = s7Banner({ sig, lineage: 'main', stepUsd: 0.065, money: EN });
    expect(b.scenario).toBe('S7');
    expect(b.reason).toBe('test failing for the 3rd time: npx vitest run auth.spec');
    expect(b.estimate).toBe('each extra step: ≈ $0.07 per step · estimate');
    expect(b.actions.map((a) => a.key)).toEqual(['stop', 'hint', 'continue']);
  });
  it('a subagent is named', () => {
    expect(s7Banner({ sig, lineage: 'agent:a1', stepUsd: null, money: API }).reason).toContain('(субагент)');
  });
  it('the hint tells the agent to stop and take another approach', () => {
    expect(agentHint('ru', 'тест падает')).toContain('другой подход');
    expect(agentHint('en', 'x'.repeat(500)).length).toBeLessThan(260);
  });
});

describe('reasons', () => {
  it('translated, unknown ones kept', () => {
    expect(reasonsText({ reasons: ['planning keywords: 1', 'no strong signal'] }, 'ru')).toBe('слова про план/подход ×1, no strong signal');
    expect(reasonsText({ reasons: ['heavy keywords: 3'] }, 'en')).toBe('architecture/complexity words ×3');
  });
});
