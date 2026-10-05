import { describe, expect, it } from 'vitest';
import { langFromEnv, orchestrateSection, orchestrateText, ORCHESTRATE_SECTION_ID } from './orchestrate.ts';

describe('the orchestrator section (P7)', () => {
  for (const lang of ['ru', 'en'] as const) {
    it(`${lang}: at most 25 lines, names the three agents, one fixed session-scope section`, () => {
      const t = orchestrateText(lang);
      expect(t.split('\n').length).toBeLessThanOrEqual(25);
      for (const a of ['agento-scout', 'agento-builder', 'agento-checker']) expect(t).toContain(a);
      for (const m of ['haiku', 'sonnet']) expect(t).toContain(m);
      const s = orchestrateSection(lang);
      expect(s).toEqual({ id: ORCHESTRATE_SECTION_ID, text: t, scope: 'session' });
    });
  }
  it('is byte-identical every time: no clock, no counter', () => {
    expect(orchestrateSection('en').text).toBe(orchestrateSection('en').text);
    expect(JSON.stringify(orchestrateSection('ru'))).toBe(JSON.stringify(orchestrateSection('ru')));
  });
  it('language from LANG', () => {
    expect(langFromEnv('ru_RU.UTF-8')).toBe('ru');
    expect(langFromEnv('en_US.UTF-8')).toBe('en');
    expect(langFromEnv(undefined)).toBe('en');
  });
});
