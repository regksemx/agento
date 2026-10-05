// Strings of `dataset label`. ru is the primary language.

import type { Lang } from '../../report/i18n.ts';

export interface LabelStrings {
  title: string;
  progress(i: number, total: number, saved: number): string;
  followUps(n: number): string;
  boxTitle: string;
  moreLines(n: number): string;
  expandHint: string;
  collapseHint: string;
  factsTitle: string;
  steps: string;
  files: string;
  lines: string;
  subagents: string;
  errors: string;
  testFailures: string;
  corrections: string;
  planMode: string;
  durationMin(m: number): string;
  durationHourMin(h: number, m: number): string;
  durationSec(s: number): string;
  costApi(cost: string): string;
  noEffort: string;
  guessesHidden: string;
  guessesLabel: string;
  guessRules: string;
  guessNone: string;
  answered: string;
  qTier: string;
  qEffort: string;
  qPlan: string;
  qDelegate: string;
  optSkip: string;
  optUnsure: string;
  yes: string;
  no: string;
  tierWord: string;
  effortWord: string;
  planWord: string;
  delegateWord: string;
  keys: string;
  keysExpanded: string;
  keysGuesses: string;
  keysArrows: string;
  step(i: number, n: number): string;
  notTty: string;
  nothingToLabel: string;
  nothingHint: string;
  noTasksFile(path: string): string;
  // report
  reportTitle: string;
  reportHeader(labeled: string, unsure: string, total: string): string;
  noLabels: string;
  distTitle: string;
  distHint: string;
  effortLabel: string;
  planYes(n: string, share: string): string;
  delegateYes(n: string, share: string): string;
  meanTime(s: string): string;
  agreeTitle: string;
  agreeHint: string;
  colSource: string;
  colN: string;
  colTier: string;
  colUnder: string;
  colOver: string;
  colEffort: string;
  src: Record<'l0' | 'rules' | 'l1' | 'history', string>;
  noL1: string;
  l1Flags(plan: string, delegate: string): string;
  confL1Title: string;
  confL0Title: string;
  confHint: string;
  rowHuman: string;
  colGuess: string;
  colTotal: string;
  smallSample(n: number): string;
  l1Verdict(under: string, over: string): string;
  fileLabel: string;
  savedNow(n: string): string;
  csvWritten(path: string, n: string): string;
  goldNote: string;
}

const ru: LabelStrings = {
  title: 'agento · разметка',
  progress: (i, total, saved) => `${i} / ${total} · записано ${saved}`,
  followUps: (n) => `реплик после: ${n}`,
  boxTitle: 'Задача',
  moreLines: (n) => {
    const m10 = n % 10;
    const m100 = n % 100;
    const w = m10 === 1 && m100 !== 11 ? 'строка' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'строки' : 'строк';
    return `…ещё ${n} ${w}`;
  },
  expandHint: 'e — развернуть',
  collapseHint: 'e — свернуть',
  factsTitle: 'Что было',
  steps: 'шаги',
  files: 'файлы',
  lines: 'строки',
  subagents: 'субагенты',
  errors: 'ошибки',
  testFailures: 'тесты упали',
  corrections: 'поправки',
  planMode: 'plan mode',
  durationMin: (m) => `${m} мин`,
  durationHourMin: (h, m) => `${h} ч ${String(m).padStart(2, '0')} мин`,
  durationSec: (s) => `${s} с`,
  costApi: (c) => `${c} (по ценам API)`,
  noEffort: 'effort ?',
  guessesHidden: 'догадки скрыты, чтобы не подсказывать (g — показать)',
  guessesLabel: 'догадки',
  guessRules: 'правила',
  guessNone: '—',
  answered: 'ваши ответы',
  qTier: 'Какой модели хватило бы с первой попытки?',
  qEffort: 'Effort?',
  qPlan: 'Нужен был этап архитектуры (plan) с сильной моделью?',
  qDelegate: 'Можно было отдать разведку дешёвому субагенту?',
  optSkip: 'пропустить',
  optUnsure: 'не помню',
  yes: 'да',
  no: 'нет',
  tierWord: 'модель',
  effortWord: 'effort',
  planWord: 'plan',
  delegateWord: 'разведка',
  keys: 'b назад · g догадки · e развернуть · s пропустить · q выйти',
  keysExpanded: 'b назад · g догадки · e свернуть · s пропустить · q выйти',
  keysGuesses: 'b назад · g скрыть догадки · e развернуть · s пропустить · q выйти',
  keysArrows: '←/→ выбор, Enter подтвердить',
  step: (i, n) => `${i}/${n}`,
  notTty: 'для разметки нужен интерактивный терминал (stdin не TTY). Запустите команду в терминале; `--report` и `--export-csv` работают и без него.',
  nothingToLabel: 'Все задачи уже размечены или подходящих задач нет.',
  nothingHint: 'Повторить разметку: `agento dataset label --report` покажет итоги.',
  noTasksFile: (p) => `нет ${p}: сначала \`agento dataset build\``,
  reportTitle: 'agento · ваши метки',
  reportHeader: (l, u, t) => `размечено ${l} · «не помню» ${u} · задач в датасете ${t}`,
  noLabels: 'Размеченных задач пока нет: запустите `agento dataset label`.',
  distTitle: 'Что вы ответили',
  distHint: 'Дешёвая достаточная конфигурация в ретроспективе: модель и effort, плюс два флага.',
  effortLabel: 'effort',
  planYes: (n, s) => `нужен был plan с сильной моделью: ${n} (${s})`,
  delegateYes: (n, s) => `разведку можно было отдать субагенту: ${n} (${s})`,
  meanTime: (s) => `среднее время на задачу: ${s}`,
  agreeTitle: 'Согласие с вашими метками',
  agreeHint: 'Совпадение тира с вашим ответом. Недороутинг: угадано дешевле, чем нужно (задача бы не вышла). Переороутинг: дороже, чем нужно (деньги впустую).',
  colSource: 'кто',
  colN: 'задач',
  colTier: 'тир',
  colUnder: 'недо',
  colOver: 'пере',
  colEffort: 'effort',
  src: { l0: 'L0 (траектория)', rules: 'правила v1', l1: 'L1 судья', history: 'история' },
  noL1: 'L1-судья: нет вердиктов на размеченных задачах (нет файла в judge/ или другие задачи).',
  l1Flags: (p, d) => `флаги L1: plan совпал в ${p}, разведка в ${d}`,
  confL1Title: 'Вы против L1',
  confL0Title: 'Вы против L0',
  confHint: 'Строки: ваш ответ. Столбцы: догадка. Правее диагонали: догадка дороже нужного. Левее: дешевле, это недороутинг.',
  rowHuman: 'вы сказали',
  colGuess: 'догадка',
  colTotal: 'всего',
  smallSample: (n) => `Выборка маленькая (${n}): проценты ориентировочные, разметьте хотя бы 30-50 задач.`,
  l1Verdict: (u, o) => `L1 на ваших задачах: недороутинг ${u}, переороутинг ${o}.`,
  fileLabel: 'файл',
  savedNow: (n) => `записано в этой сессии: ${n}`,
  csvWritten: (p, n) => `CSV: ${p} (${n} строк)`,
  goldNote: 'Эти метки читает экспорт обучения как золото (источник L2, вес 1.0).',
};

const en: LabelStrings = {
  title: 'agento · labeling',
  progress: (i, total, saved) => `${i} / ${total} · saved ${saved}`,
  followUps: (n) => `follow-ups: ${n}`,
  boxTitle: 'Task',
  moreLines: (n) => `…${n} more line${n === 1 ? '' : 's'}`,
  expandHint: 'e — expand',
  collapseHint: 'e — collapse',
  factsTitle: 'What happened',
  steps: 'steps',
  files: 'files',
  lines: 'lines',
  subagents: 'subagents',
  errors: 'errors',
  testFailures: 'test failures',
  corrections: 'corrections',
  planMode: 'plan mode',
  durationMin: (m) => `${m} min`,
  durationHourMin: (h, m) => `${h} h ${String(m).padStart(2, '0')} min`,
  durationSec: (s) => `${s} s`,
  costApi: (c) => `${c} (API-equivalent)`,
  noEffort: 'effort ?',
  guessesHidden: 'guesses hidden so they do not anchor you (g — reveal)',
  guessesLabel: 'guesses',
  guessRules: 'rules',
  guessNone: '—',
  answered: 'your answers',
  qTier: 'Which model would have been enough on the first try?',
  qEffort: 'Effort?',
  qPlan: 'Did it need an architecture (plan) stage with a strong model?',
  qDelegate: 'Could the exploration go to a cheap subagent?',
  optSkip: 'skip',
  optUnsure: "don't remember",
  yes: 'yes',
  no: 'no',
  tierWord: 'model',
  effortWord: 'effort',
  planWord: 'plan',
  delegateWord: 'explore',
  keys: 'b back · g guesses · e expand · s skip · q quit',
  keysExpanded: 'b back · g guesses · e collapse · s skip · q quit',
  keysGuesses: 'b back · g hide guesses · e expand · s skip · q quit',
  keysArrows: '←/→ choose, Enter confirm',
  step: (i, n) => `${i}/${n}`,
  notTty: 'labeling needs an interactive terminal (stdin is not a TTY). Run it in a terminal; `--report` and `--export-csv` work without one.',
  nothingToLabel: 'Every task is already labeled, or there is nothing suitable to label.',
  nothingHint: 'Use `agento dataset label --report` to see the results.',
  noTasksFile: (p) => `no ${p}: run \`agento dataset build\` first`,
  reportTitle: 'agento · your labels',
  reportHeader: (l, u, t) => `labeled ${l} · "don't remember" ${u} · tasks in the dataset ${t}`,
  noLabels: 'No labeled tasks yet: run `agento dataset label`.',
  distTitle: 'What you answered',
  distHint: 'The cheapest sufficient configuration in hindsight: model and effort, plus two flags.',
  effortLabel: 'effort',
  planYes: (n, s) => `needed a plan from a strong model: ${n} (${s})`,
  delegateYes: (n, s) => `exploration could go to a subagent: ${n} (${s})`,
  meanTime: (s) => `mean time per task: ${s}`,
  agreeTitle: 'Agreement with your labels',
  agreeHint: 'Tier match with your answer. Under-routing: the guess is cheaper than needed (the task would have failed). Over-routing: more expensive than needed (wasted money).',
  colSource: 'source',
  colN: 'tasks',
  colTier: 'tier',
  colUnder: 'under',
  colOver: 'over',
  colEffort: 'effort',
  src: { l0: 'L0 (trajectory)', rules: 'rules v1', l1: 'L1 judge', history: 'history' },
  noL1: 'L1 judge: no verdicts on the labeled tasks (no file in judge/, or other tasks).',
  l1Flags: (p, d) => `L1 flags: plan agrees in ${p}, explore in ${d}`,
  confL1Title: 'You vs L1',
  confL0Title: 'You vs L0',
  confHint: 'Rows: your answer. Columns: the guess. Right of the diagonal: the guess is dearer than needed. Left: cheaper, that is under-routing.',
  rowHuman: 'you said',
  colGuess: 'guess',
  colTotal: 'total',
  smallSample: (n) => `Small sample (${n}): the percentages are indicative, label at least 30-50 tasks.`,
  l1Verdict: (u, o) => `L1 on your tasks: under-routing ${u}, over-routing ${o}.`,
  fileLabel: 'file',
  savedNow: (n) => `saved in this session: ${n}`,
  csvWritten: (p, n) => `CSV: ${p} (${n} rows)`,
  goldNote: 'The training export reads these labels as gold (source L2, weight 1.0).',
};

export function labelStrings(lang: Lang): LabelStrings {
  return lang === 'en' ? en : ru;
}
