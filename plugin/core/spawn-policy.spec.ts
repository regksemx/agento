import { describe, expect, it } from 'vitest';
import { decideSpawnModel, isImplementPrompt, isSearchPrompt, isSensitivePrompt, parseMode, type SpawnInput } from './spawn-policy.ts';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';

const base = (o: Partial<SpawnInput>): SpawnInput => ({
  subagentType: 'general-purpose',
  prompt: 'do something',
  parentModel: OPUS,
  mode: 'balanced',
  ...o,
});

describe('decideSpawnModel: table rows of spec 5.5', () => {
  it('explicit model from the caller is untouched', () => {
    const d = decideSpawnModel(base({ subagentType: 'Explore', requestedModel: 'opus', prompt: 'find usages of foo' }));
    expect(d.model).toBeUndefined();
    expect(d.reason).toBe('explicit-model');
  });

  it('fork is untouched', () => {
    const d = decideSpawnModel(base({ subagentType: 'fork', prompt: 'find usages of foo' }));
    expect(d.model).toBeUndefined();
    expect(d.reason).toBe('fork-inherits-cache');
  });

  it.each(['agento-scout', 'agento-builder', 'agento-checker', 'agento:scout'])('%s is untouched', (t) => {
    expect(decideSpawnModel(base({ subagentType: t, prompt: 'find usages of foo' })).model).toBeUndefined();
  });

  it('Explore goes to haiku from opus', () => {
    expect(decideSpawnModel(base({ subagentType: 'Explore', prompt: 'look at the repo' }))).toEqual({ model: 'haiku', reason: 'explore-agent' });
  });

  it('Explore goes to haiku from sonnet and fable', () => {
    expect(decideSpawnModel(base({ subagentType: 'Explore', parentModel: SONNET })).model).toBe('haiku');
    expect(decideSpawnModel(base({ subagentType: 'Explore', parentModel: 'claude-fable-5-1' })).model).toBe('haiku');
  });

  it('search/read/summarize prompt on general-purpose goes to haiku', () => {
    expect(decideSpawnModel(base({ prompt: 'Search the codebase for all callers of parseConfig and summarize them' })).model).toBe('haiku');
    expect(decideSpawnModel(base({ prompt: 'Read src/auth/*.ts and give me a summary' })).model).toBe('haiku');
  });

  it('russian search prompt goes to haiku', () => {
    expect(decideSpawnModel(base({ prompt: 'Найди все места, где используется parseConfig, и сделай сводку' })).model).toBeDefined();
    expect(decideSpawnModel(base({ prompt: 'Поищи в репозитории упоминания таймаута и перечисли файлы' })).model).toBe('haiku');
    expect(decideSpawnModel(base({ prompt: 'Прочитай docs/api.md и кратко перескажи' })).model).toBe('haiku');
  });

  it('general-purpose with an implementation task goes to sonnet when the parent is pricier', () => {
    expect(decideSpawnModel(base({ prompt: 'Implement the retry helper in src/net.ts and add tests' }))).toEqual({ model: 'sonnet', reason: 'implementation' });
    expect(decideSpawnModel(base({ prompt: 'Реализуй функцию retry в src/net.ts и добавь тесты' }))).toEqual({ model: 'sonnet', reason: 'implementation' });
    expect(decideSpawnModel(base({ prompt: 'Implement it', parentModel: 'claude-fable-5-1' })).model).toBe('sonnet');
  });

  it('a prompt that both searches and implements counts as implementation, not a cheap read', () => {
    expect(decideSpawnModel(base({ prompt: 'Find the bug in the parser and fix it' })).model).toBe('sonnet');
    expect(decideSpawnModel(base({ prompt: 'Find the bug and fix it', parentModel: SONNET })).model).toBeUndefined();
  });

  it('implementation is only routed for general-purpose', () => {
    expect(decideSpawnModel(base({ subagentType: 'my-custom-agent', prompt: 'Implement the retry helper' })).model).toBeUndefined();
  });

  it('Plan is untouched', () => {
    const d = decideSpawnModel(base({ subagentType: 'Plan', prompt: 'find the files and design the change' }));
    expect(d.model).toBeUndefined();
    expect(d.reason).toBe('plan-review-security');
  });

  it.each([
    ['code-reviewer', 'look at the diff'],
    ['general-purpose', 'Review the changes in src/ and read the tests'],
    ['general-purpose', 'Find security vulnerabilities in the login flow'],
    ['general-purpose', 'Сделай ревью кода и прочитай тесты'],
    ['Explore', 'Audit how secrets are handled'],
    ['general-purpose', 'Найди уязвимости в обработке ввода'],
    ['security-auditor', 'read the code'],
  ])('review/security (%s: %s) is untouched', (subagentType, prompt) => {
    expect(decideSpawnModel(base({ subagentType, prompt })).model).toBeUndefined();
  });

  it('unrelated prompts on general-purpose are untouched', () => {
    expect(decideSpawnModel(base({ prompt: 'Think about the best naming scheme' })).reason).toBe('no-rule');
  });
});

describe('decideSpawnModel: never above the parent (P3)', () => {
  it('sonnet target with a haiku parent is untouched', () => {
    expect(decideSpawnModel(base({ prompt: 'Implement the helper', parentModel: HAIKU })).model).toBeUndefined();
  });
  it('sonnet target with a sonnet parent is untouched (no gain)', () => {
    const d = decideSpawnModel(base({ prompt: 'Implement the helper', parentModel: SONNET }));
    expect(d.model).toBeUndefined();
    expect(d.reason).toBe('not-cheaper-than-parent');
  });
  it('haiku target with a haiku parent is untouched', () => {
    expect(decideSpawnModel(base({ subagentType: 'Explore', parentModel: HAIKU })).model).toBeUndefined();
  });
  it('parent given as an alias works', () => {
    expect(decideSpawnModel(base({ subagentType: 'Explore', parentModel: 'opus' })).model).toBe('haiku');
    expect(decideSpawnModel(base({ subagentType: 'Explore', parentModel: 'haiku' })).model).toBeUndefined();
  });
  it('unknown parent model is untouched', () => {
    expect(decideSpawnModel(base({ subagentType: 'Explore', parentModel: 'some-gateway-model' })).reason).toBe('unknown-parent-model');
  });
  it('the decision never names a model above the parent, across every parent and type', () => {
    const order = ['haiku', 'sonnet', 'opus', 'fable'];
    const parents = ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-opus-4-8', 'claude-fable-5-1'];
    for (const parentModel of parents) {
      for (const subagentType of ['Explore', 'general-purpose', 'Plan', 'fork', 'x']) {
        for (const prompt of ['find x', 'implement y', 'think']) {
          const d = decideSpawnModel(base({ subagentType, prompt, parentModel }));
          if (!d.model) continue;
          const parentTier = parentModel.includes('haiku') ? 'haiku' : parentModel.includes('sonnet') ? 'sonnet' : parentModel.includes('opus') ? 'opus' : 'fable';
          expect(order.indexOf(d.model)).toBeLessThan(order.indexOf(parentTier));
        }
      }
    }
  });
});

describe('decideSpawnModel: modes', () => {
  it.each(['quality', 'off'] as const)('%s never touches', (mode) => {
    const d = decideSpawnModel(base({ mode, subagentType: 'Explore', prompt: 'find usages of foo' }));
    expect(d.model).toBeUndefined();
    expect(d.reason).toBe(`mode-${mode}`);
  });
  it.each(['balanced', 'eco'] as const)('%s routes', (mode) => {
    expect(decideSpawnModel(base({ mode, subagentType: 'Explore' })).model).toBe('haiku');
  });
  it('parseMode', () => {
    expect(parseMode('eco')).toBe('eco');
    expect(parseMode('quality')).toBe('quality');
    expect(parseMode('nonsense')).toBe('balanced');
    expect(parseMode(undefined)).toBe('balanced');
  });
});

describe('keyword detection', () => {
  it.each([
    'find all usages', 'Search for the config loader', 'grep the logs', 'look for TODOs', 'read the README', 'Summarize the module', 'give me an overview',
    'where is the retry logic', 'which files import this', 'investigating the cause',
    'найди все вызовы', 'поищи в коде', 'прочитай файл', 'сделай сводку', 'изучи структуру', 'где находится конфиг', 'какие файлы затронуты',
  ])('search: %s', (p) => expect(isSearchPrompt(p)).toBe(true));

  it.each(['ready to go', 'the readme says hi', 'thread safety', 'compose a poem', 'подготовь релиз'])('not search: %s', (p) => expect(isSearchPrompt(p)).toBe(false));

  it.each(['implement X', 'Write a test', 'adding a field', 'fix the bug', 'create a file', 'rewrite it', 'реализуй X', 'напиши тест', 'исправь баг', 'добавь поле'])(
    'implement: %s',
    (p) => expect(isImplementPrompt(p)).toBe(true),
  );

  it.each(['address the question', 'a nice day'])('not implement: %s', (p) => expect(isImplementPrompt(p)).toBe(false));

  it.each(['review the diff', 'security hole', 'vulnerabilities', 'ревью', 'проверь на уязвимости', 'безопасность'])('sensitive: %s', (p) =>
    expect(isSensitivePrompt(p)).toBe(true),
  );
});
