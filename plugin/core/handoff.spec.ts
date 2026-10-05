import { describe, expect, it } from 'vitest';
import { handoffPrompt, planDocument, planPath, planTitle, slugify } from './handoff.ts';

describe('slugify', () => {
  it('lowercase ascii with dashes', () => {
    expect(slugify('Refactor the Auth module!')).toBe('refactor-the-auth-module');
  });
  it('transliterates Russian', () => {
    expect(slugify('Рефакторинг модуля авторизации')).toBe('refaktoring-modulya-avtorizatsii');
  });
  it('is bounded and never empty', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40);
    expect(slugify('🙂🙂')).toBe('plan');
    expect(slugify('')).toBe('plan');
    expect(slugify('x'.repeat(39) + ' yyyy').endsWith('-')).toBe(false);
  });
});

describe('planTitle / planPath', () => {
  const plan = '\n# Plan: Split the billing service\n\n## Steps\n1. extract';
  it('the first heading, else the first line', () => {
    expect(planTitle(plan)).toBe('Plan: Split the billing service');
    expect(planTitle('Just a sentence\nmore')).toBe('Just a sentence');
    expect(planTitle('')).toBe('');
  });
  it('lands in .agento/plans as YYYY-MM-DD-<slug>.md, with a numeric suffix on a clash', () => {
    expect(planPath('2026-10-05', plan)).toBe('.agento/plans/2026-10-05-plan-split-the-billing-service.md');
    expect(planPath('2026-10-05', plan, 1)).toBe('.agento/plans/2026-10-05-plan-split-the-billing-service-2.md');
    expect(planPath('2026-10-05', '')).toBe('.agento/plans/2026-10-05-plan.md');
  });
});

describe('planDocument / handoffPrompt', () => {
  it('the plan as approved, newline-terminated', () => {
    expect(planDocument('a')).toBe('a\n');
    expect(planDocument('a\n')).toBe('a\n');
  });
  it('names the path and asks to stop on gaps (ru/en)', () => {
    const ru = handoffPrompt('.agento/plans/x.md', 'ru');
    const en = handoffPrompt('.agento/plans/x.md', 'en');
    expect(ru.startsWith('Реализуй план из .agento/plans/x.md.')).toBe(true);
    expect(en.startsWith('Implement the plan in .agento/plans/x.md.')).toBe(true);
    expect(ru).toContain('спроси');
    expect(en).toContain('ask');
  });
});
