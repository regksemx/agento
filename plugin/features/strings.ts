import type { LoopSignal } from '../core/loop-guard.ts';

export type Lang = 'ru' | 'en';

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function ordinalEn(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

// Why the agent looks stuck, without the lead-in: the banner's reason line.
export function loopReason(sig: LoopSignal, lang: Lang, lineage: string): string {
  const who = lineage === 'main' ? '' : lang === 'ru' ? ' (субагент)' : ' (subagent)';
  const detail = clip(sig.detail, 60);
  if (lang === 'ru') {
    switch (sig.kind) {
      case 'failing-test':
        return `тест падает уже ${sig.count}-й раз${who}: ${detail}`;
      case 'same-edit':
        return `одно место правится ${sig.count}-й раз${who}: ${detail}`;
      case 'error-streak':
        return `${sig.count} ошибок инструментов подряд${who}`;
    }
  }
  switch (sig.kind) {
    case 'failing-test':
      return `test failing for the ${ordinalEn(sig.count)} time${who}: ${detail}`;
    case 'same-edit':
      return `same spot edited ${sig.count} times${who}: ${detail}`;
    case 'error-streak':
      return `${sig.count} tool errors in a row${who}`;
  }
}

// The short toast for a loop signal (the full banner comes with the suggestions UI).
export function loopToast(sig: LoopSignal, lang: Lang, lineage: string): string {
  const who = lineage === 'main' ? '' : lang === 'ru' ? ' (субагент)' : ' (subagent)';
  const detail = clip(sig.detail, 48);
  if (lang === 'ru') {
    switch (sig.kind) {
      case 'failing-test':
        return `Агент буксует${who}: тест падает уже ${sig.count}-й раз: ${detail}`;
      case 'same-edit':
        return `Агент буксует${who}: одно место правится ${sig.count}-й раз: ${detail}`;
      case 'error-streak':
        return `Агент буксует${who}: ${sig.count} ошибок инструментов подряд`;
    }
  }
  switch (sig.kind) {
    case 'failing-test':
      return `Agent looks stuck${who}: test failing for the ${ordinalEn(sig.count)} time: ${detail}`;
    case 'same-edit':
      return `Agent looks stuck${who}: same spot edited ${sig.count} times: ${detail}`;
    case 'error-streak':
      return `Agent looks stuck${who}: ${sig.count} tool errors in a row`;
  }
}
