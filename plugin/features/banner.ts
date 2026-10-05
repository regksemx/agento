// The text of the banners above the prompt (ru/en) and how an estimate is phrased. Pure: no `$`.
// A banner always carries a reason and, where one can be made, an estimate marked as such (P4, P6).

import type { AgentoBanner, AgentoBannerAction, AgentoBannerData } from '../types';
import { fmtPct, formatUsd, shortModel } from './status.ts';
import type { EstimateBasis } from '../core/estimate.ts';
import type { TaskVerdict } from '../core/task.ts';
import type { Downgrade, S4Reason } from '../core/suggest.ts';
import type { LoopSignal } from '../core/loop-guard.ts';
import { loopReason, type Lang } from './strings.ts';

// What an amount is shown in: dollars, or for a subscriber with a calibration, a share of the weekly limit (spec §7.8).
export interface MoneyCtx {
  lang: Lang;
  isSubscription: boolean;
  // Percent of the weekly limit per API-equivalent dollar, once fitted from this user's own history.
  pctPerUsd: number | null;
}

// `≈ −$0.18 per task · estimate`, or `≈ −0.6% of the weekly limit per task · estimate` for a calibrated subscriber.
export function savingLine(usd: number | null, basis: EstimateBasis | null, m: MoneyCtx, unit: 'task' | 'step' = 'task'): string | null {
  if (usd === null || !(usd > 0)) return null;
  const ru = m.lang === 'ru';
  let amount: string;
  if (m.isSubscription && m.pctPerUsd !== null) {
    amount = ru ? `${fmtPct(usd * m.pctPerUsd)} недельного лимита` : `${fmtPct(usd * m.pctPerUsd)} of the weekly limit`;
  } else if (m.isSubscription) {
    amount = ru ? `${formatUsd(usd)} API-эквивалента` : `${formatUsd(usd)} API-equivalent`;
  } else {
    amount = formatUsd(usd);
  }
  const per = unit === 'task' ? (ru ? 'на такой задаче' : 'on a task like this') : ru ? 'за шаг' : 'per step';
  const how = basis === 'history' ? (ru ? 'оценка по вашим задачам' : 'estimate from your tasks') : ru ? 'оценка' : 'estimate';
  return `≈ −${amount} ${per} · ${how}`;
}

// The cost of something that keeps running (a stuck agent, an old context): shown per step, no minus sign.
export function costLine(usd: number | null, m: MoneyCtx): string | null {
  if (usd === null || !(usd > 0)) return null;
  const ru = m.lang === 'ru';
  const amount =
    m.isSubscription && m.pctPerUsd !== null
      ? ru ? `${fmtPct(usd * m.pctPerUsd)} недельного лимита` : `${fmtPct(usd * m.pctPerUsd)} of the weekly limit`
      : formatUsd(usd);
  return ru ? `≈ ${amount} за шаг · оценка` : `≈ ${amount} per step · estimate`;
}

export function reasonsText(v: Pick<TaskVerdict, 'reasons'>, lang: Lang): string {
  const out = v.reasons.map((r) => {
    let m = /^light keywords: (\d+)$/.exec(r);
    if (m) return lang === 'ru' ? `слова лёгкой задачи ×${m[1]}` : `light-task words ×${m[1]}`;
    m = /^short prompt: (\d+) chars$/.exec(r);
    if (m) return lang === 'ru' ? `короткий запрос (${m[1]} симв.)` : `short prompt (${m[1]} chars)`;
    m = /^heavy keywords: (\d+)$/.exec(r);
    if (m) return lang === 'ru' ? `слова про архитектуру/сложность ×${m[1]}` : `architecture/complexity words ×${m[1]}`;
    m = /^planning keywords: (\d+)$/.exec(r);
    if (m) return lang === 'ru' ? `слова про план/подход ×${m[1]}` : `planning words ×${m[1]}`;
    m = /^brain \S+: plan first$/.exec(r);
    if (m) return lang === 'ru' ? 'обученная модель: сначала план' : 'trained model: plan first';
    m = /^brain \S+: delegate exploring$/.exec(r);
    if (m) return lang === 'ru' ? 'обученная модель: начать с разведки' : 'trained model: explore first';
    return r;
  });
  return out.join(', ');
}

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// `opus·high`, `sonnet`, or the raw id for a model with no known tier.
export function setupLabel(model: string, effort: string | null): string {
  return effort ? `${shortModel(model)}·${effort}` : shortModel(model);
}

export type BannerBase = Omit<AgentoBanner, 'id' | 'ts' | 'cwd'>;

export interface S1Input {
  down: Downgrade;
  verdict: TaskVerdict;
  current: { model: string; effort: string | null };
  saving: { usd: number; basis: EstimateBasis } | null;
  money: MoneyCtx;
}

// What the verdict's setup is called: `sonnet·medium`, with the parts agento would not change left as they are.
function targetLabel(i: Pick<S1Input, 'down' | 'current'>): string {
  const model = i.down.model ?? shortModel(i.current.model);
  const effort = i.down.effort ?? i.current.effort;
  return effort ? `${model}·${effort}` : model;
}

function actionsFor(lang: Lang, down: Downgrade): AgentoBannerAction[] {
  const ru = lang === 'ru';
  const out: AgentoBannerAction[] = [];
  if (down.model) out.push({ key: 'model', label: cap(down.model), primary: true });
  if (down.effort) out.push({ key: 'effort', label: ru ? `Effort ${down.effort}` : `Effort ${down.effort}`, primary: !down.model });
  out.push({ key: 'keep', label: ru ? 'Оставить' : 'Keep' });
  out.push({ key: 'never', label: ru ? 'Не предлагать' : "Don't suggest" });
  return out;
}

function s1Data(i: S1Input): AgentoBannerData {
  return { ...(i.down.model ? { model: i.down.model } : {}), ...(i.down.effort ? { effort: i.down.effort } : {}), fromModel: i.current.model, fromEffort: i.current.effort, estimateUsd: i.saving?.usd ?? null };
}

export function s1Banner(i: S1Input): BannerBase {
  const ru = i.money.lang === 'ru';
  const cur = setupLabel(i.current.model, i.current.effort);
  const target = targetLabel(i);
  const effortOnly = !i.down.model;
  const title = effortOnly ? (ru ? 'Effort выше, чем нужно этой задаче' : 'Effort is higher than this task needs') : ru ? 'Похоже на лёгкую задачу' : 'Looks like a light task';
  const reason = ru
    ? `Для такой задачи хватит ${target} (сейчас ${cur}). Причина: ${reasonsText(i.verdict, 'ru')}. Смена в начале задачи дёшева: кэш пуст или ещё мал.`
    : `${target} is enough here (now ${cur}). Why: ${reasonsText(i.verdict, 'en')}. Switching early in a task is cheap: the cache is empty or still small.`;
  const est = savingLine(i.saving?.usd ?? null, i.saving?.basis ?? null, i.money);
  const fallback = effortOnly ? (ru ? 'меньше thinking-токенов, он оплачивается как output (оценка недоступна)' : 'fewer thinking tokens, billed as output (no estimate)') : null;
  return { scenario: 'S1', title, reason, estimate: est ?? fallback, actions: actionsFor(i.money.lang, i.down), data: s1Data(i) };
}

// What undo restores: the model, the effort, or both, as the user had them.
function backLabel(i: Pick<S1Input, 'down' | 'current'>): string {
  if (i.down.model && i.down.effort) return setupLabel(i.current.model, i.current.effort);
  if (i.down.model) return shortModel(i.current.model);
  return `effort ${i.current.effort ?? ''}`.trim();
}

// The notice after autopilot changed the setup at a clean point: reversible, and switch-off-able (P4).
export function autopilotBanner(i: S1Input): BannerBase {
  const ru = i.money.lang === 'ru';
  const cur = setupLabel(i.current.model, i.current.effort);
  const target = targetLabel(i);
  const back = backLabel(i);
  return {
    scenario: 'AP',
    title: ru ? `agento: ${target} для этой задачи` : `agento: ${target} for this task`,
    reason: ru
      ? `Автопилот в чистой точке (смена бесплатна для кэша); было ${cur}. Причина: ${reasonsText(i.verdict, 'ru')}.`
      : `Autopilot at a clean point (switching is free for the cache); was ${cur}. Why: ${reasonsText(i.verdict, 'en')}.`,
    estimate: savingLine(i.saving?.usd ?? null, i.saving?.basis ?? null, i.money),
    actions: [
      { key: 'undo', label: ru ? `Вернуть ${back}` : `Back to ${back}`, primary: true },
      { key: 'disable', label: ru ? 'Выключить автопилот' : 'Turn autopilot off' },
      { key: 'ok', label: 'OK' },
    ],
    data: s1Data(i),
  };
}

export function autopilotToast(i: Pick<S1Input, 'down' | 'current' | 'money'>): string {
  const ru = i.money.lang === 'ru';
  const cur = setupLabel(i.current.model, i.current.effort);
  const target = targetLabel(i);
  return ru ? `agento: ${target} для этой задачи (было ${cur}). Вернуть: кнопка над полем ввода` : `agento: ${target} for this task (was ${cur}). Undo: button above the prompt`;
}

export interface S2aInput {
  verdict: TaskVerdict;
  current: { model: string; effort: string | null };
  stepExtraUsd: number | null;
  money: MoneyCtx;
}

export function s2aBanner(i: S2aInput): BannerBase {
  const ru = i.money.lang === 'ru';
  const cur = setupLabel(i.current.model, i.current.effort);
  const est = costLine(i.stepExtraUsd, i.money);
  return {
    scenario: 'S2a',
    title: ru ? `Сложная задача, а у вас ${cur}` : `A hard task, and you are on ${cur}`,
    reason: ru
      ? `Похоже на архитектуру или планирование (${reasonsText(i.verdict, 'ru')}). Обсудите план с Opus в plan mode, а код потом напишет Sonnet из чистого контекста.`
      : `Looks like architecture or planning (${reasonsText(i.verdict, 'en')}). Discuss the plan with Opus in plan mode; Sonnet writes the code afterwards from a clean context.`,
    estimate: est ? (ru ? `Opus дороже: ${est}; код потом на Sonnet` : `Opus costs more: ${est}; code later on Sonnet`) : null,
    actions: [
      { key: 'discuss', label: ru ? 'Обсудить архитектуру с Opus (plan mode)' : 'Discuss the architecture with Opus (plan mode)', primary: true },
      { key: 'no', label: ru ? 'Нет' : 'No' },
      { key: 'never', label: ru ? 'Не предлагать' : "Don't suggest" },
    ],
    data: { fromModel: i.current.model, fromEffort: i.current.effort },
  };
}

export interface S2bInput {
  plan: string | null;
  plannerTokens: number | null;
  savingUsd: number | null;
  orchestrate: boolean;
  money: MoneyCtx;
}

export function s2bBanner(i: S2bInput): BannerBase {
  const ru = i.money.lang === 'ru';
  const ctx = i.plannerTokens ? `${Math.round(i.plannerTokens / 1000)}k` : null;
  const est = savingLine(i.savingUsd, 'default', i.money);
  const actions: AgentoBannerAction[] = [
    { key: 'handoff', label: ru ? 'Писать код на Sonnet — чистый контекст' : 'Write the code on Sonnet — clean context', primary: true },
    { key: 'continue', label: ru ? 'Продолжить на Opus' : 'Continue on Opus' },
  ];
  // The orchestra variant is phase 1.5 and only exists when orchestrator mode was fixed at session start (P7).
  if (i.orchestrate) actions.push({ key: 'orchestra', label: ru ? 'Opus руководит, Sonnet пишет (оркестр)' : 'Opus leads, Sonnet writes (orchestra)' });
  actions.push({ key: 'never', label: ru ? 'Не предлагать' : "Don't suggest" });
  return {
    scenario: 'S2b',
    title: ru ? 'План одобрен' : 'Plan approved',
    reason: ru
      ? `План сохранится в .agento/plans/, Sonnet начнёт с контекстом ~8k вместо ${ctx ?? 'всей переписки'}.`
      : `The plan is saved to .agento/plans/ and Sonnet starts with ~8k of context instead of ${ctx ?? 'the whole conversation'}.`,
    estimate: est,
    actions,
    data: { ...(i.plan ? { plan: i.plan } : {}) },
  };
}

export interface S4Input {
  why: S4Reason;
  contextTokens: number;
  perStepUsd: number | null;
  taskSavingUsd: number | null;
  prompt: string;
  money: MoneyCtx;
}

export function s4Banner(i: S4Input): BannerBase {
  const ru = i.money.lang === 'ru';
  const k = `${Math.round(i.contextTokens / 1000)}k`;
  const perStep = i.perStepUsd ? (ru ? `≈ ${formatUsd(i.perStepUsd)}/шаг` : `≈ ${formatUsd(i.perStepUsd)}/step`) : null;
  const title =
    i.why === 'topic-shift' ? (ru ? 'Новая тема в длинном контексте' : 'New topic in a long context') : i.why === 'new-task' ? (ru ? 'Новая задача в длинном контексте' : 'New task in a long context') : ru ? `Контекст вырос до ${k}` : `The context grew to ${k}`;
  const reason = ru
    ? `Старый контекст ${k} читается на каждом шаге${perStep ? ` (${perStep})` : ''}. /clear — он перестанет читаться; промпт вернётся в поле ввода.`
    : `The old ${k} context is read on every step${perStep ? ` (${perStep})` : ''}. /clear stops that; your prompt comes back to the input box.`;
  return {
    scenario: 'S4',
    title,
    reason,
    estimate: savingLine(i.taskSavingUsd, 'default', i.money),
    actions: [
      { key: 'clear', label: '/clear', primary: true },
      { key: 'compact', label: ru ? 'Сжать с сохранением важного' : 'Compact, keep what matters' },
      { key: 'keep', label: ru ? 'Оставить' : 'Keep' },
      { key: 'never', label: ru ? 'Не предлагать' : "Don't suggest" },
    ],
    data: { prompt: i.prompt },
  };
}

export interface S7Input {
  sig: LoopSignal;
  lineage: string;
  stepUsd: number | null;
  money: MoneyCtx;
}

export function s7Banner(i: S7Input): BannerBase {
  const ru = i.money.lang === 'ru';
  return {
    scenario: 'S7',
    title: ru ? 'Агент буксует' : 'The agent looks stuck',
    reason: loopReason(i.sig, i.money.lang, i.lineage),
    estimate: costLine(i.stepUsd, i.money) ? (ru ? `каждый лишний шаг: ${costLine(i.stepUsd, i.money)}` : `each extra step: ${costLine(i.stepUsd, i.money)}`) : null,
    actions: [
      { key: 'stop', label: ru ? 'Остановить' : 'Stop', primary: true },
      { key: 'hint', label: ru ? 'Подсказка агенту' : 'Hint for the agent' },
      { key: 'continue', label: ru ? 'Продолжить' : 'Continue' },
    ],
    data: { lineage: i.lineage, detail: i.sig.detail },
  };
}

// What the "hint for the agent" adds to the next prompt's context (never submitted for the user).
export function agentHint(lang: Lang, detail: string): string {
  const d = detail.slice(0, 120);
  return lang === 'ru'
    ? `[agento] Ты, похоже, буксуешь (${d}). Остановись, перечитай ошибку целиком, не повторяй то же действие и предложи другой подход.`
    : `[agento] You seem to be stuck (${d}). Stop, re-read the error in full, do not repeat the same action, and propose a different approach.`;
}
