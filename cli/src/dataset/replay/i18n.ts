// Strings of the `dataset replay` terminal output. ru is the primary language.

import type { Lang } from '../../report/i18n.ts';
import type { Account } from './plan.ts';
import type { SkipReason } from './types.ts';

export interface ReplayStrings {
  title: string;
  headerLabeled(l: string, t: string): string;
  reasons: Record<SkipReason, string>;
  // selection and plan
  selectTitle: string;
  dryTitle: string;
  selTitle: string;
  selHint: string;
  selectedLabel: string;
  skippedLabel: string;
  dirtyNote(n: string): string;
  noCandidates: string;
  candidatesTitle: string;
  candidateRow(project: string, test: string, edited: string): string;
  moreCandidates(n: string): string;
  planTitle: string;
  planHint: string;
  planShape(tasks: string, ladder: string, samples: string, runs: string): string;
  planChecks(tests: string, edited: string, n: string): string;
  planCost(low: string, high: string): string;
  planBudget(b: string): string;
  planExceeds: string;
  planDaily(n: string): string;
  accounts: Record<Account, string>;
  noJudgeDiffNote: string;
  // confirm
  confirmTitle: string;
  confirmPrompt: string;
  confirmNeedsYes: string;
  confirmDeclined: string;
  // summary
  runTitle: string;
  runHint: string;
  replayedLabel: string;
  labeledLabel: string;
  inconclusiveLabel: string;
  skippedRunLabel: string;
  runsLine(count: string, passed: string): string;
  spent(runs: string, judge: string, budget: string): string;
  stopped(reason: string): string;
  distTitle: string;
  distHint: string;
  fallbackNote(n: string, share: string): string;
  obsTitle: string;
  obsHint: string;
  obsRow: string;
  l2Col: string;
  colTotal: string;
  overSpec(n: string, share: string): string;
  l1Title: string;
  l1Hint: string;
  l1Row: string;
  l1Compared(n: string, file: string, thr: string): string;
  l1Exact(share: string, tier: string): string;
  l1Under(n: string, share: string): string;
  l1Over(n: string, share: string): string;
  l1None: string;
  l1TooFew: string;
  written: string;
  runtime(ms: string): string;
  goldNote: string;
  weakCheckNote: string;
  nextNote: string;
  // errors
  needMaxTasks: string;
  needBudget: string;
}

const ru: ReplayStrings = {
  title: 'agento dataset replay',
  headerLabeled: (l, t) => `L2-метки: ${l} из ${t} задач`,
  reasons: {
    'already-labeled': 'уже есть L2-метка',
    'no-source': 'задачи нет в локальных транскриптах',
    'multi-prompt': 'больше одного содержательного промпта',
    'no-cwd': 'в транскрипте нет cwd',
    'cwd-missing': 'каталога проекта больше нет',
    'not-a-repo': 'не git-репозиторий',
    'no-branch': 'ветка не записана (или detached HEAD)',
    'branch-missing': 'ветки больше нет в репозитории',
    'no-commit': 'нет коммита до начала задачи',
    'stale-commit': 'ближайший коммит слишком старый',
    'dirty-start': 'рабочее дерево было грязным',
    'no-verification': 'задача ничего не правила: повтор без правок проходит любую проверку',
  },
  selectTitle: 'Отбор (--select)',
  dryTitle: 'Пробный запуск (--dry-run): ничего не запускается',
  selTitle: 'Отбор задач',
  selHint: 'Повторяемы только задачи с одним промптом (или с «да»/«продолжай»), в git-проекте, который ещё есть на диске, с известным стартовым коммитом.',
  selectedLabel: 'пригодны для повтора',
  skippedLabel: 'отброшено',
  dirtyNote: (n) => `${n} задач начались с грязным деревом: они отброшены (--include-dirty оставит их, метка будет менее надёжной).`,
  noCandidates: 'Повторять нечего.',
  candidatesTitle: 'Первые в очереди',
  candidateRow: (p, t, e) => `${p} · ${t} · ${e}`,
  moreCandidates: (n) => `…и ещё ${n}`,
  planTitle: 'План',
  planHint: 'Лестница идёт снизу вверх и останавливается на первой конфигурации, где прошли все сэмплы.',
  planShape: (t, l, s, r) => `${t} задач × лестница ${l} × ${s} сэмпла(ов): не более ${r} прогонов`,
  planChecks: (t, e, n) => `проверки: тесты проекта у ${t}, правки файлов у ${e} из ${n}`,
  planCost: (lo, hi) => `оценка стоимости: ${lo} (все задачи проходят на первой ступени) … ${hi} (все поднимаются до конца), по API-ценам, с запасом ×1.5`,
  planBudget: (b) => `бюджет --budget-usd: ${b}; прогон не начнётся, если его оценка не влезает в остаток`,
  planExceeds: 'Верхняя оценка выше бюджета: часть лестниц может остановиться недоделанной (метка не записывается).',
  planDaily: (n) => `без API-ключа: не более ${n} прогонов в сутки (--max-runs-per-day)`,
  accounts: {
    'api-key': 'аккаунт: ключ API (ANTHROPIC_API_KEY): это реальные деньги',
    subscription: 'аккаунт: подписка (ключа API в окружении нет): прогоны расходуют недельный лимит',
    cloud: 'аккаунт: облачный провайдер (Bedrock/Vertex/Foundry): счёт провайдера',
  },
  noJudgeDiffNote: 'Без --judge-diff проверка «дифф непустой» слабая: любая правка проходит. Для задач без тестов лучше включить судью.',
  confirmTitle: 'Это тратит деньги или лимит подписки Claude',
  confirmPrompt: 'Запустить прогоны? [y/N] ',
  confirmNeedsYes: 'Нужно подтверждение: запустите в терминале или добавьте --yes.',
  confirmDeclined: 'Отменено, ничего не потрачено.',
  runTitle: 'Этот запуск',
  runHint: 'Каждый прогон дописывается в runs.jsonl сразу, метка задачи в labels.jsonl после лестницы; повторный запуск продолжает.',
  replayedLabel: 'повторено',
  labeledLabel: 'получили метку',
  inconclusiveLabel: 'без вердикта (сбой запуска)',
  skippedRunLabel: 'отброшено при отборе',
  runsLine: (c, p) => `прогонов: ${c}, из них прошли проверки: ${p}`,
  spent: (r, j, b) => `потрачено: ${r} на прогоны${j} из бюджета ${b}`,
  stopped: (r) => `остановлено: ${r}`,
  distTitle: 'Метки L2',
  distHint: 'Самая дешёвая конфигурация, прошедшая все проверки; если не прошла ни одна, opus·medium.',
  fallbackNote: (n, s) => `${n} (${s}) задач не прошла ни на одной ступени: метка opus·medium по умолчанию`,
  obsTitle: 'История против L2',
  obsHint: 'Строки: модель, на которой задача реально шла. Столбцы: что хватило по повтору. Левее Opus: хватало дешевле.',
  obsRow: 'в истории',
  l2Col: 'L2',
  colTotal: 'всего',
  overSpec: (n, s) => `шло на Opus/Fable, а L2 нашёл sonnet или haiku: ${n} (${s})`,
  l1Title: 'L1 против L2: проверка судьи',
  l1Hint: 'Главный результат: насколько вердикты судьи подтверждаются повторами. Строки: L1, столбцы: L2. Правее диагонали: судья просил дешевле, чем реально нужно (риск качества).',
  l1Row: 'L1',
  l1Compared: (n, f, t) => `сравнено ${n} задач · файл судьи ${f} · порог ${t}`,
  l1Exact: (s, t) => `совпали конфигурация целиком: ${s}, тир: ${t}`,
  l1Under: (n, s) => `судья дешевле, чем хватило (недо-роутинг, риск): ${n} (${s})`,
  l1Over: (n, s) => `судья дороже, чем нужно (упущенная экономия): ${n} (${s})`,
  l1None: 'Файла судьи нет: запустите `agento dataset judge`, и здесь появится сравнение L1 и L2.',
  l1TooFew: 'Пересечения L1 и L2 пока нет.',
  written: 'файлы',
  runtime: (ms) => `готово за ${ms}`,
  goldNote: 'L2 надёжнее L1, но тоже не абсолют: 2 сэмпла, проверки только те, что удалось определить. Это калибровка, а не истина.',
  weakCheckNote: 'Проверка «дифф непустой» не доказывает качество; тесты и --judge-diff сильнее.',
  nextNote: 'Дальше: калибровка порога L1 и L0 по этим меткам; `agento train` берёт L2 как золото.',
  needMaxTasks: '--max-tasks обязателен: повторы тратят лимит подписки или деньги',
  needBudget: '--budget-usd обязателен: повторы тратят лимит подписки или деньги',
};

const en: ReplayStrings = {
  title: 'agento dataset replay',
  headerLabeled: (l, t) => `L2 labels: ${l} of ${t} tasks`,
  reasons: {
    'already-labeled': 'already has an L2 label',
    'no-source': 'task is not in the local transcripts',
    'multi-prompt': 'more than one substantive prompt',
    'no-cwd': 'no cwd in the transcript',
    'cwd-missing': 'project directory no longer exists',
    'not-a-repo': 'not a git repository',
    'no-branch': 'no branch recorded (or detached HEAD)',
    'branch-missing': 'branch no longer exists in the repository',
    'no-commit': 'no commit before the task started',
    'stale-commit': 'nearest commit is too old',
    'dirty-start': 'working tree was dirty at the start',
    'no-verification': 'the task edited no files: a replay that changes nothing passes any check',
  },
  selectTitle: 'Selection (--select)',
  dryTitle: 'Dry run (--dry-run): nothing is executed',
  selTitle: 'Task selection',
  selHint: 'Only tasks with one prompt (or bare confirmations such as "yes"/"go on") in a git project that still exists and has a known starting commit can be replayed.',
  selectedLabel: 'replayable',
  skippedLabel: 'skipped',
  dirtyNote: (n) => `${n} tasks started with a dirty working tree and were skipped (--include-dirty keeps them; their labels are less reliable).`,
  noCandidates: 'Nothing to replay.',
  candidatesTitle: 'First in the queue',
  candidateRow: (p, t, e) => `${p} · ${t} · ${e}`,
  moreCandidates: (n) => `…and ${n} more`,
  planTitle: 'Plan',
  planHint: 'The ladder climbs from the cheapest configuration and stops at the first one where every sample passes.',
  planShape: (t, l, s, r) => `${t} tasks × ladder ${l} × ${s} sample(s): at most ${r} runs`,
  planChecks: (t, e, n) => `checks: project tests for ${t}, file edits for ${e} of ${n}`,
  planCost: (lo, hi) => `estimated cost: ${lo} (every task passes on the first rung) … ${hi} (every task climbs the whole ladder), at API prices, with a 1.5× margin`,
  planBudget: (b) => `budget --budget-usd: ${b}; a run does not start if its estimate does not fit in what is left`,
  planExceeds: 'The upper estimate is above the budget: some ladders may stop unfinished (no label is written for them).',
  planDaily: (n) => `without an API key: at most ${n} runs per day (--max-runs-per-day)`,
  accounts: {
    'api-key': 'account: API key (ANTHROPIC_API_KEY): real money',
    subscription: 'account: subscription (no API key in the environment): runs spend the weekly limit',
    cloud: 'account: cloud provider (Bedrock/Vertex/Foundry): the provider\'s bill',
  },
  noJudgeDiffNote: 'Without --judge-diff the "diff is not empty" check is weak: any edit passes. For tasks without tests, turn the judge on.',
  confirmTitle: 'This spends money or your Claude subscription limit',
  confirmPrompt: 'Run the replays? [y/N] ',
  confirmNeedsYes: 'Confirmation needed: run in a terminal or add --yes.',
  confirmDeclined: 'Cancelled, nothing was spent.',
  runTitle: 'This run',
  runHint: 'Every run is appended to runs.jsonl at once, a task label to labels.jsonl after its ladder; running again continues.',
  replayedLabel: 'replayed',
  labeledLabel: 'labeled',
  inconclusiveLabel: 'no verdict (run failure)',
  skippedRunLabel: 'skipped at selection',
  runsLine: (c, p) => `runs: ${c}, of which passed all checks: ${p}`,
  spent: (r, j, b) => `spent: ${r} on runs${j} of a ${b} budget`,
  stopped: (r) => `stopped: ${r}`,
  distTitle: 'L2 labels',
  distHint: 'The cheapest configuration that passed every check; when none did, opus·medium.',
  fallbackNote: (n, s) => `${n} (${s}) tasks passed on no rung: labeled opus·medium by default`,
  obsTitle: 'History vs L2',
  obsHint: 'Rows: the model the task actually ran on. Columns: what the replay found sufficient. Left of Opus: cheaper would have done.',
  obsRow: 'in history',
  l2Col: 'L2',
  colTotal: 'total',
  overSpec: (n, s) => `ran on Opus/Fable, L2 found sonnet or haiku enough: ${n} (${s})`,
  l1Title: 'L1 vs L2: judge validation',
  l1Hint: 'The key result: how well the judge verdicts hold up under replay. Rows: L1, columns: L2. Right of the diagonal the judge asked for less than turned out to be needed (a quality risk).',
  l1Row: 'L1',
  l1Compared: (n, f, t) => `${n} tasks compared · judge file ${f} · threshold ${t}`,
  l1Exact: (s, t) => `whole configuration agrees: ${s}, tier: ${t}`,
  l1Under: (n, s) => `judge cheaper than what sufficed (under-routing, a risk): ${n} (${s})`,
  l1Over: (n, s) => `judge dearer than needed (missed saving): ${n} (${s})`,
  l1None: 'No judge file: run `agento dataset judge` and the L1 vs L2 comparison appears here.',
  l1TooFew: 'No overlap between L1 and L2 yet.',
  written: 'files',
  runtime: (ms) => `done in ${ms}`,
  goldNote: 'L2 is sturdier than L1 but not absolute: 2 samples, and only the checks that could be determined. It is calibration, not truth.',
  weakCheckNote: 'A non-empty diff does not prove quality; tests and --judge-diff are stronger.',
  nextNote: 'Next: calibrate the L1 threshold and L0 against these labels; `agento train` takes L2 as gold.',
  needMaxTasks: '--max-tasks is required: replays spend subscription limit or money',
  needBudget: '--budget-usd is required: replays spend subscription limit or money',
};

export function replayStrings(lang: Lang): ReplayStrings {
  return lang === 'en' ? en : ru;
}
