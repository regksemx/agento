// Strings of the `dataset judge` terminal output. ru is the primary language.

import type { Lang } from '../../report/i18n.ts';

export interface JudgeStrings {
  title: string;
  headerTasks(judged: string, total: string): string;
  judgeLine(backend: string, model: string, prompt: string, threshold: string): string;
  noTasks: string;
  runTitle: string;
  runHint: string;
  judgedLabel: string;
  skippedLabel: string;
  failedLabel: string;
  failedDetail(parse: string, transport: string): string;
  usage(inTok: string, outTok: string): string;
  usageCost(cost: string): string;
  aborted(reason: string): string;
  staleWarn(n: string): string;
  distTitle: string;
  distHint: string;
  planFirst(n: string, share: string): string;
  delegate(n: string, share: string): string;
  meanDifficulty(d: string): string;
  l0Title: string;
  l0Hint: string;
  l0Row: string;
  l1Col: string;
  colTotal: string;
  agree(share: string): string;
  histTitle: string;
  histHint: string;
  histRow: string;
  overSpec(count: string, share: string, cost: string, saving: string): string;
  written: string;
  runtime(ms: string): string;
  unvalidatedNote: string;
  nextNote: string;
  // dry run
  dryTitle: string;
  dryTasks(pending: string, total: string, judged: string): string;
  dryTokens(input: string, output: string, system: string): string;
  dryOwnGpu: string;
  dryCost(cost: string, model: string): string;
  dryCostUnknown(model: string): string;
  drySubscription: string;
  dryNoMax: string;
  dryNothing: string;
  dryFile: string;
  // confirmation
  confirmTitle: string;
  confirmPrompt: string;
  confirmNeedsYes: string;
  confirmDeclined: string;
}

const ru: JudgeStrings = {
  title: 'agento dataset judge',
  headerTasks: (j, t) => `оценено ${j} из ${t}`,
  judgeLine: (b, m, p, th) => `судья: ${b} · ${m} · промпт ${p} · порог p ≥ ${th}`,
  noTasks: 'Нет задач: сначала выполните `agento dataset build` или проверьте --tasks.',
  runTitle: 'Этот запуск',
  runHint: 'Вердикты дописываются в файл по мере готовности; повторный запуск продолжает с того же места.',
  judgedLabel: 'оценено',
  skippedLabel: 'пропущено (уже есть)',
  failedLabel: 'ошибки',
  failedDetail: (p, t) => `ответ не разобран: ${p} · сбой бэкенда: ${t}`,
  usage: (i, o) => `токены судьи: ${i} вход · ${o} выход`,
  usageCost: (c) => `стоимость по API-ценам: ≈ ${c}`,
  aborted: (r) => `запуск остановлен: ${r}`,
  staleWarn: (n) => `${n} вердиктов получены другим промптом; чтобы переоценить, добавьте --force`,
  distTitle: 'Метки L1',
  distHint: 'Самая дешёвая конфигурация с p ≥ порога; если ни одна не проходит, opus·medium.',
  planFirst: (n, s) => `нужен план сначала: ${n} (${s})`,
  delegate: (n, s) => `разведку можно отдать субагенту: ${n} (${s})`,
  meanDifficulty: (d) => `средняя сложность по судье: ${d} из 5`,
  l0Title: 'L0 против L1',
  l0Hint: 'Строки: слабая метка по траектории. Столбцы: вердикт судьи. Правее диагонали судья считает задачу сложнее, чем траектория.',
  l0Row: 'L0',
  l1Col: 'L1',
  colTotal: 'всего',
  agree: (s) => `L0 и L1 совпадают по тиру в ${s} задач`,
  histTitle: 'История против L1',
  histHint: 'Строки: модель, на которой задача реально шла. Столбцы: вердикт судьи. Левее Opus: судья считает, что хватило бы дешевле.',
  histRow: 'в истории',
  overSpec: (c, s, cost, sv) => `шло на Opus/Fable, судья говорит sonnet или haiku хватало: ${c} (${s}), стоили ${cost}, экономия ≈ ${sv}`,
  written: 'вердикты',
  runtime: (ms) => `готово за ${ms}`,
  unvalidatedNote: 'L1 не проверена: это мнение судьи по законченной задаче. Доказательством станут L2-перепрогоны.',
  nextNote: 'Дальше: `agento dataset replay` (L2) проверит дешёвые конфигурации на деле и откалибрует порог.',
  dryTitle: 'Пробный запуск (--dry-run)',
  dryTasks: (p, t, j) => `к оценке: ${p} из ${t} задач (уже оценено: ${j})`,
  dryTokens: (i, o, s) => `≈ ${i} входных токенов (из них системный промпт ${s} на вызов) · ≈ ${o} выходных`,
  dryOwnGpu: 'свой сервер: денег не тратит, нужно только время GPU',
  dryCost: (c, m) => `claude ${m}: ≈ ${c} по API-ценам (верхняя оценка, без кэша)`,
  dryCostUnknown: (m) => `claude ${m}: цена модели неизвестна`,
  drySubscription: 'На подписке эти вызовы расходуют недельный лимит; на API-ключе это реальные деньги.',
  dryNoMax: 'Для бэкенда claude при реальном запуске обязателен --max-tasks.',
  dryNothing: 'Оценивать нечего: все задачи уже оценены (--force пересчитает).',
  dryFile: 'файл',
  confirmTitle: 'Это тратит лимит вашей подписки Claude',
  confirmPrompt: 'Продолжить? [y/N] ',
  confirmNeedsYes: 'Нужно подтверждение: запустите в терминале или добавьте --yes.',
  confirmDeclined: 'Отменено, ничего не потрачено.',
};

const en: JudgeStrings = {
  title: 'agento dataset judge',
  headerTasks: (j, t) => `${j} of ${t} judged`,
  judgeLine: (b, m, p, th) => `judge: ${b} · ${m} · prompt ${p} · threshold p ≥ ${th}`,
  noTasks: 'No tasks: run `agento dataset build` first or check --tasks.',
  runTitle: 'This run',
  runHint: 'Verdicts are appended as they arrive; running again continues where this one stopped.',
  judgedLabel: 'judged',
  skippedLabel: 'skipped (already judged)',
  failedLabel: 'failed',
  failedDetail: (p, t) => `unparseable answer: ${p} · backend failure: ${t}`,
  usage: (i, o) => `judge tokens: ${i} in · ${o} out`,
  usageCost: (c) => `API-equivalent cost: ≈ ${c}`,
  aborted: (r) => `run stopped: ${r}`,
  staleWarn: (n) => `${n} verdicts came from a different prompt version; add --force to re-judge them`,
  distTitle: 'L1 labels',
  distHint: 'The cheapest configuration with p ≥ threshold; when none reaches it, opus·medium.',
  planFirst: (n, s) => `needs a plan first: ${n} (${s})`,
  delegate: (n, s) => `exploration can go to a subagent: ${n} (${s})`,
  meanDifficulty: (d) => `mean judged difficulty: ${d} of 5`,
  l0Title: 'L0 vs L1',
  l0Hint: 'Rows: the weak trajectory label. Columns: the judge verdict. Right of the diagonal the judge finds the task harder than the trajectory suggests.',
  l0Row: 'L0',
  l1Col: 'L1',
  colTotal: 'total',
  agree: (s) => `L0 and L1 agree on the tier for ${s} of tasks`,
  histTitle: 'History vs L1',
  histHint: 'Rows: the model the task actually ran on. Columns: the judge verdict. Left of Opus: the judge says something cheaper would have done.',
  histRow: 'in history',
  overSpec: (c, s, cost, sv) => `ran on Opus/Fable, judge says sonnet or haiku suffices: ${c} (${s}), cost ${cost}, saving ≈ ${sv}`,
  written: 'verdicts',
  runtime: (ms) => `done in ${ms}`,
  unvalidatedNote: 'L1 is unvalidated: it is the judge\'s opinion of a finished task. L2 replays will be the proof.',
  nextNote: 'Next: `agento dataset replay` (L2) tests the cheaper configurations for real and calibrates the threshold.',
  dryTitle: 'Dry run (--dry-run)',
  dryTasks: (p, t, j) => `to judge: ${p} of ${t} tasks (already judged: ${j})`,
  dryTokens: (i, o, s) => `≈ ${i} input tokens (system prompt ${s} per call included) · ≈ ${o} output tokens`,
  dryOwnGpu: 'your own server: costs no money, only GPU time',
  dryCost: (c, m) => `claude ${m}: ≈ ${c} at API prices (upper bound, no caching)`,
  dryCostUnknown: (m) => `claude ${m}: model price unknown`,
  drySubscription: 'On a subscription these calls spend the weekly limit; on an API key they are real money.',
  dryNoMax: 'The claude backend requires --max-tasks for a real run.',
  dryNothing: 'Nothing to judge: every task already has a verdict (--force re-judges).',
  dryFile: 'file',
  confirmTitle: 'This spends your Claude subscription limit',
  confirmPrompt: 'Proceed? [y/N] ',
  confirmNeedsYes: 'Confirmation needed: run in a terminal or add --yes.',
  confirmDeclined: 'Cancelled, nothing was spent.',
};

export function judgeStrings(lang: Lang): JudgeStrings {
  return lang === 'en' ? en : ru;
}
