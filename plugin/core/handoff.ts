// The architect → executor handoff (spec §7.4, S2): where the plan goes and what the executor is told.
// Pure TypeScript.

export type HandoffLang = 'ru' | 'en';

export const PLANS_DIR = '.agento/plans';

const RU: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// `Рефакторинг auth-модуля` → `refaktoring-auth-modulya`: lowercase ASCII, dashes, at most `max` characters.
export function slugify(text: string, max = 40): string {
  const latin = [...text.toLowerCase()].map((ch) => RU[ch] ?? ch).join('');
  const slug = latin
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, max).replace(/-+$/g, '');
  return cut || 'plan';
}

// The plan's title: its first Markdown heading, else its first non-empty line.
export function planTitle(plan: string): string {
  const lines = plan.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  const line = (heading ?? lines[0] ?? '').replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();
  return line;
}

export function planPath(date: string, plan: string, attempt = 0): string {
  const suffix = attempt > 0 ? `-${attempt + 1}` : '';
  return `${PLANS_DIR}/${date}-${slugify(planTitle(plan))}${suffix}.md`;
}

// A plan file is the plan as it was approved, with a trailing newline.
export function planDocument(plan: string): string {
  return plan.endsWith('\n') ? plan : `${plan}\n`;
}

// What lands in the prompt box after /clear and /model: a human presses Enter.
export function handoffPrompt(path: string, lang: HandoffLang): string {
  return lang === 'ru'
    ? `Реализуй план из ${path}. Прочитай его целиком и иди по шагам; после каждого шага запускай проверки из раздела критериев приёмки. Если в плане чего-то не хватает или он противоречит коду, остановись и спроси, а не додумывай.`
    : `Implement the plan in ${path}. Read it in full and follow its steps; after each step run the checks from its acceptance criteria. If something is missing from the plan or it contradicts the code, stop and ask rather than guess.`;
}

// Plan text above this size is not carried in session state (the file is still written from the tool's own copy).
export const MAX_PLAN_CHARS = 200_000;
