// Strings of the `dataset build` terminal summary. ru is the primary language.

import type { Lang } from '../report/i18n.ts';
import type { ScrubKind } from './scrub.ts';

export interface DatasetStrings {
  title: string;
  header(tasks: string, sessions: string, projects: string): string;
  written: string;
  summaryFile: string;
  filter(since: string, project?: string): string;
  confusionTitle: string;
  confusionHint: string;
  rowHeader: string;
  colTotal: string;
  observedLabel: string;
  overSpec(count: string, share: string, cost: string): string;
  distTitle: string;
  distHint: string;
  effortLabel: string;
  correctionsTitle: string;
  corrections(count: string, share: string): string;
  rulesAgree(share: string): string;
  scrubTitle: string;
  scrubNone: string;
  scrubTotal(n: string): string;
  kind: Record<ScrubKind, string>;
  runtime(ms: string): string;
  weakNote: string;
  nextNote: string;
  noTasks: string;
}

const ru: DatasetStrings = {
  title: 'agento dataset',
  header: (t, s, p) => `${t} · ${s} · ${p}`,
  written: 'датасет',
  summaryFile: 'сводка',
  filter: (since, project) => `период: ${since === 'all' ? 'всё время' : since}${project ? ` · проект: ${project}` : ''}`,
  confusionTitle: 'История против L0',
  confusionHint: 'Строки: модель, на которой задача реально шла. Столбцы: слабая метка L0 (какая хватило бы по траектории). Выше диагонали: Opus там, где L0 не видит нужды.',
  rowHeader: 'в истории',
  colTotal: 'всего',
  observedLabel: 'модель в истории',
  overSpec: (c, s, cost) => `Opus/Fable в истории, а L0 говорит sonnet или haiku: ${c} (${s}), ≈ ${cost}`,
  distTitle: 'Метки L0',
  distHint: 'Тир и effort по порогам траектории: шаги, правки, ошибки, поправки, plan mode.',
  effortLabel: 'effort',
  correctionsTitle: 'Поправки пользователя',
  corrections: (c, s) => `задач с поправками или откатами: ${c} (${s})`,
  rulesAgree: (s) => `правила v1 совпадают с L0 по тиру в ${s} задач`,
  scrubTitle: 'Очистка секретов',
  scrubNone: 'ничего не найдено',
  scrubTotal: (n) => `замен: ${n}`,
  kind: {
    'private-key': 'приватные ключи',
    'url-credentials': 'URL с паролем',
    jwt: 'JWT',
    'api-key': 'API-ключи',
    bearer: 'Bearer',
    assignment: 'password/token = …',
    email: 'email',
    'home-path': 'домашние пути',
    'high-entropy': 'длинные случайные строки',
  },
  runtime: (ms) => `готово за ${ms}`,
  weakNote: 'Метки слабые (L0): это сложность задачи по ходу работы, а не доказанная достаточность дешёвой модели.',
  nextNote: 'Дальше: `agento dataset judge` (L1, Opus читает законченную задачу) и `agento dataset replay` (L2, повторный прогон на дешёвой конфигурации) уточнят метки.',
  noTasks: 'Задач не найдено: проверьте --dir, --since и --project.',
};

const en: DatasetStrings = {
  title: 'agento dataset',
  header: (t, s, p) => `${t} · ${s} · ${p}`,
  written: 'dataset',
  summaryFile: 'summary',
  filter: (since, project) => `period: ${since === 'all' ? 'all time' : since}${project ? ` · project: ${project}` : ''}`,
  confusionTitle: 'History vs L0',
  confusionHint: 'Rows: the model the task actually ran on. Columns: the weak L0 label (what the trajectory says would have been enough). Above the diagonal: Opus where L0 sees no need.',
  rowHeader: 'in history',
  colTotal: 'total',
  observedLabel: 'model in history',
  overSpec: (c, s, cost) => `Opus/Fable in history while L0 says sonnet or haiku: ${c} (${s}), ≈ ${cost}`,
  distTitle: 'L0 labels',
  distHint: 'Tier and effort from trajectory thresholds: steps, edits, errors, corrections, plan mode.',
  effortLabel: 'effort',
  correctionsTitle: 'User corrections',
  corrections: (c, s) => `tasks with corrections or reverts: ${c} (${s})`,
  rulesAgree: (s) => `rules v1 agree with L0 on the tier for ${s} of tasks`,
  scrubTitle: 'Secret scrubbing',
  scrubNone: 'nothing found',
  scrubTotal: (n) => `replacements: ${n}`,
  kind: {
    'private-key': 'private keys',
    'url-credentials': 'URLs with credentials',
    jwt: 'JWT',
    'api-key': 'API keys',
    bearer: 'Bearer',
    assignment: 'password/token = …',
    email: 'email',
    'home-path': 'home paths',
    'high-entropy': 'long random strings',
  },
  runtime: (ms) => `done in ${ms}`,
  weakNote: 'Labels are weak (L0): they measure how hard the task turned out to be, not proven sufficiency of a cheaper model.',
  nextNote: 'Next: `agento dataset judge` (L1, Opus reads the finished task) and `agento dataset replay` (L2, re-run on a cheaper configuration) will refine the labels.',
  noTasks: 'No tasks found: check --dir, --since and --project.',
};

export function datasetStrings(lang: Lang): DatasetStrings {
  return lang === 'en' ? en : ru;
}
