// Strings of `dataset import` and `dataset validate-judge`. ru is the primary language.

import type { Lang } from '../../report/i18n.ts';

export interface PublicStrings {
  importTitle: string;
  importHeader(records: string, trajectories: string): string;
  sourceLine(kind: string, input: string): string;
  commitLine(commit: string, license: string): string;
  noRecords: string;
  workloadTitle: string;
  workloadHint: string;
  workloadRow: string;
  tierCol: string;
  colTotal: string;
  tiersTitle: string;
  tiersHint: string;
  publicTierLine(parts: string): string;
  stageLine(parts: string): string;
  skippedLine(total: string, parts: string): string;
  prefixLine(mean: string, median: string, max: string, cut: string, limit: string): string;
  written: string;
  summaryFile: string;
  runtime(ms: string): string;
  noticeLabel: string;
  stepNote: string;
  nextNote: string;
  // validate-judge
  valTitle: string;
  valHeader(compared: string, labelled: string): string;
  valJudgeLine(model: string, prompt: string, threshold: string): string;
  valJudgeFile: string;
  valLabelsFile: string;
  valNone: string;
  valUnmatched(n: string): string;
  valMixedPrompts(n: string): string;
  agreeTitle: string;
  agreeHint: string;
  accuracy: string;
  underLabel: string;
  overLabel: string;
  baselineLine(share: string, tier: string): string;
  confTitle: string;
  confHint: string;
  confRow: string;
  confCol: string;
  benchTitle: string;
  benchHint: string;
  benchCols: { n: string; acc: string; under: string; over: string };
  relTitle: string;
  relHint: string;
  relCols: { bin: string; n: string; meanP: string; observed: string };
  relSummary(ece: string, brier: string, base: string): string;
  relHaiku(ece: string, base: string): string;
  sweepTitle: string;
  sweepHint: string;
  sweepCols: { thr: string; acc: string; under: string; over: string; saving: string };
  sweepOracle(s: string): string;
  sweepCurrent: string;
  sweepRecommended: string;
  recommendLine(thr: string, max: string): string;
  recommendNone(max: string): string;
  valWritten: string;
  caveatMapping: string;
  caveatStep: string;
  caveatBalance: string;
}

const ru: PublicStrings = {
  importTitle: 'agento dataset import twinrouterbench',
  importHeader: (r, t) => `${r} шагов · ${t} траекторий`,
  sourceLine: (k, i) => `источник: ${k === 'git' ? 'git' : 'путь'} · ${i}`,
  commitLine: (c, l) => `коммит ${c} · лицензия ${l}`,
  noRecords: 'Записей нет: проверьте --source (нужен question_bank.jsonl).',
  workloadTitle: 'Нагрузки и тиры',
  workloadHint: 'Строки: источник шага. Столбцы: проверенный тир после отображения в haiku/sonnet/opus.',
  workloadRow: 'нагрузка',
  tierCol: 'тир',
  colTotal: 'всего',
  tiersTitle: 'Исходные тиры',
  tiersHint: 'Метки TwinRouterBench до отображения: самый дешёвый тир, прошедший проверку исполнением.',
  publicTierLine: (p) => `low/mid/mid_high/high: ${p}`,
  stageLine: (p) => `стадия данных: ${p}`,
  skippedLine: (t, p) => `пропущено строк: ${t} (${p})`,
  prefixLine: (m, md, mx, c, l) => `префикс до обрезки: среднее ${m} · медиана ${md} · максимум ${mx} симв.; обрезано ${c} (лимит ${l})`,
  written: 'записи',
  summaryFile: 'сводка',
  runtime: (ms) => `готово за ${ms}`,
  noticeLabel: 'лицензия',
  stepNote: 'Это метки ШАГОВ агента, а не задач: тир относится к следующему вызову модели при данном префиксе.',
  nextNote: 'Дальше: `agento dataset judge --tasks <файл>` оценит эти шаги судьёй, `agento dataset validate-judge` сравнит его с проверенными тирами.',
  valTitle: 'agento dataset validate-judge',
  valHeader: (c, l) => `сравнено ${c} из ${l} шагов`,
  valJudgeLine: (m, p, t) => `судья: ${m} · промпт ${p} · порог p ≥ ${t}`,
  valJudgeFile: 'вердикты',
  valLabelsFile: 'эталон',
  valNone: 'Нечего сравнивать: у вердиктов и эталона нет общих taskId. Сначала `agento dataset judge --tasks <публичный файл>`.',
  valUnmatched: (n) => `вердиктов без эталона в файле: ${n}`,
  valMixedPrompts: (n) => `в файле вердикты ${n} разных версий промпта; метрики смешаны`,
  agreeTitle: 'Совпадение с проверенным тиром',
  agreeHint: 'Недооценка: судья дешевле, чем проверено (риск качества). Переоценка: судья дороже (упущенная экономия).',
  accuracy: 'точность',
  underLabel: 'недооценка',
  overLabel: 'переоценка',
  baselineLine: (s, t) => `для сравнения: всегда «${t}» дало бы ${s}`,
  confTitle: 'Проверенный тир против судьи',
  confHint: 'Строки: проверенный тир. Столбцы: вердикт судьи. Ниже диагонали (подсвечено) судья берёт дешевле, чем хватило бы.',
  confRow: 'проверено',
  confCol: 'L1',
  benchTitle: 'По нагрузкам',
  benchHint: 'Большинство шагов в публичных данных лёгкие; настоящий разброс тиров только у SWE-bench.',
  benchCols: { n: 'шагов', acc: 'точность', under: 'недо', over: 'пере' },
  relTitle: 'Калибровка: «хватит sonnet»',
  relHint: 'p судьи (max из sonnet·medium и sonnet·high) по корзинам против доли шагов, где проверенный тир не opus. Честный судья: наблюдаемая доля ≈ p.',
  relCols: { bin: 'p', n: 'шагов', meanP: 'средн. p', observed: 'на деле' },
  relSummary: (e, b, base) => `ECE ${e} · Brier ${b} · доля «sonnet хватает» в данных ${base}`,
  relHaiku: (e, base) => `«хватит haiku»: ECE ${e} · доля в данных ${base}`,
  sweepTitle: 'Порог p: недооценка против экономии',
  sweepHint: 'Для каждого порога метка = самая дешёвая конфигурация с p ≥ порога. Экономия по спискам цен против «всё на Opus».',
  sweepCols: { thr: 'порог', acc: 'точность', under: 'недо', over: 'пере', saving: 'экономия' },
  sweepOracle: (s) => `потолок без потери качества: выбор ровно по проверенным тирам даёт экономию ${s}; больше только за счёт недооценки`,
  sweepCurrent: 'текущий',
  sweepRecommended: 'выбор',
  recommendLine: (t, m) => `Порог ${t}: наибольшая экономия при недооценке ≤ ${m}.`,
  recommendNone: (m) => `Ни один порог из 0.5..0.9 не держит недооценку ≤ ${m}: судья пока нельзя использовать для автоматического понижения тира.`,
  valWritten: 'отчёт',
  caveatMapping: 'Тиры отображены так: low и mid в haiku, mid_high в sonnet, high в opus. Это консервативное чтение; детали в docs/public-data.md.',
  caveatStep: 'Метки относятся к шагам агента с префиксом в 6000 символов, а судья здесь не видит траекторию: это нижняя оценка его качества на задачах Claude Code.',
  caveatBalance: 'Классы несбалансированы (в основном low): смотрите недооценку и экономию, а не только точность.',
};

const en: PublicStrings = {
  importTitle: 'agento dataset import twinrouterbench',
  importHeader: (r, t) => `${r} steps · ${t} trajectories`,
  sourceLine: (k, i) => `source: ${k === 'git' ? 'git' : 'path'} · ${i}`,
  commitLine: (c, l) => `commit ${c} · license ${l}`,
  noRecords: 'No records: check --source (a question_bank.jsonl is required).',
  workloadTitle: 'Workloads and tiers',
  workloadHint: 'Rows: where the step comes from. Columns: the verified tier after mapping to haiku/sonnet/opus.',
  workloadRow: 'workload',
  tierCol: 'tier',
  colTotal: 'total',
  tiersTitle: 'Original tiers',
  tiersHint: 'TwinRouterBench labels before mapping: the cheapest tier that passed execution.',
  publicTierLine: (p) => `low/mid/mid_high/high: ${p}`,
  stageLine: (p) => `data stage: ${p}`,
  skippedLine: (t, p) => `rows skipped: ${t} (${p})`,
  prefixLine: (m, md, mx, c, l) => `prefix before the cut: mean ${m} · median ${md} · max ${mx} chars; cut ${c} (limit ${l})`,
  written: 'records',
  summaryFile: 'summary',
  runtime: (ms) => `done in ${ms}`,
  noticeLabel: 'license',
  stepNote: 'These are labels of agent STEPS, not of whole tasks: the tier is for the next model call given the prefix.',
  nextNote: 'Next: `agento dataset judge --tasks <file>` judges these steps, `agento dataset validate-judge` compares the judge with the verified tiers.',
  valTitle: 'agento dataset validate-judge',
  valHeader: (c, l) => `${c} of ${l} steps compared`,
  valJudgeLine: (m, p, t) => `judge: ${m} · prompt ${p} · threshold p ≥ ${t}`,
  valJudgeFile: 'verdicts',
  valLabelsFile: 'reference',
  valNone: 'Nothing to compare: the verdicts and the reference share no taskId. Run `agento dataset judge --tasks <public file>` first.',
  valUnmatched: (n) => `verdicts without a reference in the file: ${n}`,
  valMixedPrompts: (n) => `the file mixes verdicts of ${n} prompt versions; the metrics are blended`,
  agreeTitle: 'Agreement with the verified tier',
  agreeHint: 'Under-routing: the judge picks cheaper than verified (a quality risk). Over-routing: the judge picks dearer (a missed saving).',
  accuracy: 'accuracy',
  underLabel: 'under-routing',
  overLabel: 'over-routing',
  baselineLine: (s, t) => `for reference: always "${t}" would score ${s}`,
  confTitle: 'Verified tier vs judge',
  confHint: 'Rows: verified tier. Columns: judge verdict. Below the diagonal (highlighted) the judge picks cheaper than what sufficed.',
  confRow: 'verified',
  confCol: 'L1',
  benchTitle: 'By workload',
  benchHint: 'Most public steps are easy; a real spread of tiers exists only in SWE-bench.',
  benchCols: { n: 'steps', acc: 'accuracy', under: 'under', over: 'over' },
  relTitle: 'Calibration: "sonnet suffices"',
  relHint: 'Judge p (max of sonnet·medium and sonnet·high) by bin against the share of steps whose verified tier is not opus. A calibrated judge: observed share ≈ p.',
  relCols: { bin: 'p', n: 'steps', meanP: 'mean p', observed: 'observed' },
  relSummary: (e, b, base) => `ECE ${e} · Brier ${b} · share "sonnet suffices" in the data ${base}`,
  relHaiku: (e, base) => `"haiku suffices": ECE ${e} · share in the data ${base}`,
  sweepTitle: 'Threshold p: under-routing vs saving',
  sweepHint: 'For each threshold the label is the cheapest configuration with p ≥ threshold. Saving at list prices against "everything on Opus".',
  sweepCols: { thr: 'thr', acc: 'accuracy', under: 'under', over: 'over', saving: 'saving' },
  sweepOracle: (s) => `no-loss ceiling: choosing exactly the verified tiers saves ${s}; anything above comes from under-routing`,
  sweepCurrent: 'current',
  sweepRecommended: 'pick',
  recommendLine: (t, m) => `Threshold ${t}: the largest saving with under-routing ≤ ${m}.`,
  recommendNone: (m) => `No threshold in 0.5..0.9 keeps under-routing ≤ ${m}: do not use this judge to downgrade tiers automatically yet.`,
  valWritten: 'report',
  caveatMapping: 'Tiers are mapped as low and mid to haiku, mid_high to sonnet, high to opus. A conservative reading; details in docs/public-data.md.',
  caveatStep: 'Labels are for agent steps with a 6000-char prefix and the judge sees no trajectory here: a lower bound on its quality for Claude Code tasks.',
  caveatBalance: 'The classes are imbalanced (mostly low): read under-routing and saving, not accuracy alone.',
};

export function publicStrings(lang: Lang): PublicStrings {
  return lang === 'en' ? en : ru;
}
