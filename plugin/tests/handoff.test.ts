import { describe, expect, type Engine } from 'claude-code/testing';
import { OPUS, SONNET, prompt, rig, step, T0, type Rig } from './rig.ts';
import { manualTest as test } from './rig.ts';

const HEAVY = 'Спроектируй архитектуру распределённой очереди задач с миграцией старых данных';
const LIGHT = 'Исправь опечатку в README';
const PLAN = '# Plan: split the billing service\n\n## Goal\nExtract invoices into its own module.\n\n## Files\n- src/billing/index.ts\n\n## Steps\n1. Move types\n2. Move handlers\n\n## Acceptance\n- npm test is green\n';
const CWD = '/work/app';

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true });
const mountBand = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'agento', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { bodyRows: 12 }, view: {} } as never });

// The local date the way agento keys its days: YYYY-MM-DD.
const pad = (n: number): string => String(n).padStart(2, '0');
const today = (): string => {
  const d = new Date(T0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const PLAN_FILE = (): string => `.agento/plans/${today()}-plan-split-the-billing-service.md`;

// Opus planned in a long conversation; the model calls ExitPlanMode and the person approves.
async function planned($: Engine, r: Rig, plan: string | null = PLAN): Promise<void> {
  await start($);
  await prompt($, HEAVY);
  r.usage = { in: 0, out: 1500, read: 140_000, write: 3000 };
  await step($);
  r.results.ExitPlanMode = { plan, isAgent: false, filePath: '/home/u/.claude/plans/x.md' };
  await $.tool.call({ tool: 'ExitPlanMode' } as never);
}

describe('T19 (a): discuss the architecture with Opus', () => {
  test('a hard task at a clean point on sonnet: the banner offers plan mode on Opus', async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, HEAVY);
    const b = r.banner;
    expect(b?.scenario).toBe('S2a');
    expect(b?.title).toContain('sonnet');
    expect(b?.reason).toContain('plan mode');
    expect(b?.estimate).toContain('Opus costs more');
    expect(b?.actions.map((a) => a.key)).toEqual(['discuss', 'no', 'never']);
    expect(b?.actions[0]?.label).toBe('Discuss the architecture with Opus (plan mode)');
    expect(r.commands).toEqual([]);
  });

  test('also for a planning request ("let\'s discuss the approach") on haiku', async ($, on) => {
    const r = rig(on, { model: 'claude-haiku-4-5' });
    await start($);
    await prompt($, 'Давай обсудим подход к кэшированию результатов');
    expect(r.banner?.scenario).toBe('S2a');
  });

  test('not when the user is already on opus', async ($, on) => {
    const r = rig(on);
    await start($);
    await prompt($, HEAVY);
    expect(r.banner ?? null).toBeNull();
  });

  test('[Discuss] runs /model opus, then /plan where the build has it', async ($, on) => {
    const r = rig(on, { model: SONNET, commands: ['plan', 'clear'] });
    await start($);
    await prompt($, HEAVY);
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountBand($, surface);
      expect((await ui.find({ key: 'discuss' }))?.props.label).toBe('Discuss the architecture with Opus (plan mode)');
      await ui.unmount();
    }
    const ui = await mountBand($);
    await ui.press({ key: 'discuss' });
    expect(r.commands).toEqual([{ command: 'model', args: 'opus' }, { command: 'plan', args: '' }]);
    expect(r.model).toBe(OPUS);
    expect(r.ledger?.hints.accepted).toBe(1);
    expect(r.banner).toBeNull();
    // Nothing was sent for the person.
    expect(r.submitted).toHaveLength(1);
  });

  test('without a /plan command it points at Shift+Tab', async ($, on) => {
    const r = rig(on, { model: SONNET, commands: ['clear'] });
    await start($);
    await prompt($, HEAVY);
    const ui = await mountBand($);
    await ui.press({ key: 'discuss' });
    expect(r.commands).toEqual([{ command: 'model', args: 'opus' }]);
    expect(r.toasts[0]).toContain('Shift+Tab');
  });

  test('[No] and "don\'t suggest"; the latter silences both handoff banners for the directory', async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, HEAVY);
    const ui = await mountBand($);
    await ui.press({ key: 'no' });
    expect(r.banner).toBeNull();
    expect(r.commands).toEqual([]);
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, HEAVY);
    expect(r.banner?.scenario).toBe('S2a');
    await ui.press({ key: 'never' });
    expect(r.store.get(`dismiss:S2:${CWD}`)).toBe(true);
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, HEAVY);
    expect(r.banner).toBeNull();
    // ExitPlanMode too.
    r.results.ExitPlanMode = { plan: PLAN };
    await $.tool.call({ tool: 'ExitPlanMode' } as never);
    expect(r.banner).toBeNull();
  });

  test('quality mode never suggests it', { options: { mode: 'quality' } }, async ($, on) => {
    const r = rig(on, { model: SONNET });
    await start($);
    await prompt($, HEAVY);
    expect(r.banner).toBeNull();
  });
});

describe('T19 (b): ExitPlanMode approved', () => {
  test('the banner offers a clean-context start on Sonnet, with the executor\'s context against the planner\'s', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    const b = r.banner;
    expect(b?.scenario).toBe('S2b');
    expect(b?.title).toBe('Plan approved');
    expect(b?.reason).toContain('143k');
    expect(b?.reason).toContain('.agento/plans/');
    expect(b?.estimate).toMatch(/^≈ −\$\d\.\d\d on a task like this · estimate$/);
    expect(b?.actions.map((a) => [a.key, a.label])).toEqual([
      ['handoff', 'Write the code on Sonnet — clean context'],
      ['continue', 'Continue on Opus'],
      ['never', "Don't suggest"],
    ]);
    // The plan is read off the tool's result: ExitPlanMode's input carries none.
    expect(b?.data.plan).toBe(PLAN);
  });

  test('buttons on both surfaces', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountBand($, surface);
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(3);
      expect((await ui.find({ key: 'handoff' }))?.props.label).toBe('Write the code on Sonnet — clean context');
      await ui.unmount();
    }
  });

  test('[Write the code on Sonnet]: plan file, then clear, then sonnet for that task, then the text in the box — and nothing is sent', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    const path = PLAN_FILE();
    expect(r.files.get(path)).toBe(PLAN);
    expect([...r.files.keys()]).toEqual([path]);
    // No /model: it would make sonnet the default of every new session. Sonnet holds for the executor's task.
    expect(r.commands).toEqual([{ command: 'clear', args: '' }]);
    expect(r.task?.override).toMatchObject({ model: 'sonnet', modelId: SONNET, fromModel: OPUS });
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]?.text.startsWith(`Implement the plan in ${path}.`)).toBe(true);
    // The person presses Enter: agento never submits for them (the one submit is the planning prompt).
    expect(r.submitted.map((s) => s.text)).toEqual([HEAVY]);
    expect(r.banner).toBeNull();
    // The /clear's own session.end may land after the press: the executor's setup survives it, and its task runs on sonnet.
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, r.fills[0]?.text ?? '');
    r.steps.length = 0;
    await step($, { model: OPUS, effort: 'high' });
    expect(r.steps[0]?.model).toBe(SONNET);
    expect(r.model).toBe(OPUS);
    expect(r.toasts.at(-1)).toBe(`Plan saved: ${path}. Press Enter to start on Sonnet`);
  });

  test('russian text when LANG is ru', async ($, on) => {
    const r = rig(on, { lang: 'ru_RU.UTF-8' });
    await planned($, r);
    const ui = await mountBand($);
    expect((await ui.find({ key: 'handoff' }))?.props.label).toBe('Писать код на Sonnet — чистый контекст');
    await ui.press({ key: 'handoff' });
    expect(r.fills[0]?.text.startsWith(`Реализуй план из ${PLAN_FILE()}.`)).toBe(true);
  });

  test('the order is the spec\'s: file, clear, model, fill', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect([...r.files.keys()]).toEqual([PLAN_FILE()]);
    expect(r.commands.map((c) => c.command)).toEqual(['clear']);
    expect(r.fills).toHaveLength(1);
  });

  test('a model whose sonnet id is not ours to name (a cloud id): /model sonnet, as before', async ($, on) => {
    const r = rig(on, { model: 'us.anthropic.claude-opus-5-5-v1:0' });
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect(r.commands.map((c) => c.command)).toEqual(['clear', 'model']);
  });

  test('the next prompt (the person pressing Enter on the plan text) is met with no suggestion', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, r.fills[0]?.text ?? '');
    expect(r.banner ?? null).toBeNull();
    expect(r.submitted.at(-1)?.text).toBe(r.fills[0]?.text);
    // The prompt after that is an ordinary one again.
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await prompt($, LIGHT);
    expect(r.banner?.scenario).toBe('S1');
  });

  test('the ledger records the handoff: executor context against planner context, and the credit', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect(r.ledger?.handoff).toEqual({ ts: T0, planPath: PLAN_FILE(), plannerTokens: 143_000, executorTokens: null });
    expect(r.ledger?.credit).toMatchObject({ mechanism: 'handoff', fromModel: OPUS, model: 'sonnet' });
    expect(r.ledger?.hints.accepted).toBe(1);
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    r.usage = { in: 600, out: 1500, read: 0, write: 7900, model: SONNET };
    await step($, { model: SONNET, effort: 'medium', index: 0 });
    expect(r.ledger?.handoff?.executorTokens).toBe(8500);
    const s = r.ledger?.recent.at(-1);
    expect(s?.mechanism).toBe('handoff');
    expect(s?.savedEstimate).toBeGreaterThan(0);
    expect(r.ledger?.savedEstimate.handoff).toBeGreaterThan(0);
    const day = r.store.get([...r.store.keys()].find((k) => k.startsWith('day:')) as string) as { savedEstimate: { handoff: number }; hintsAccepted: number };
    expect(day.savedEstimate.handoff).toBeGreaterThan(0);
    expect(day.hintsAccepted).toBe(1);
  });

  test('a running turn is ended first: the planning model must not carry on in a context that is about to go', async ($, on) => {
    const r = rig(on);
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true });
    await $.turn.start({ text: 'plan', turnId: 't7' } as never);
    r.results.ExitPlanMode = { plan: PLAN };
    await $.tool.call({ tool: 'ExitPlanMode' } as never);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect(r.aborts).toEqual(['t7']);
    expect(r.commands.map((c) => c.command)).toEqual(['clear']);
  });

  test('a name that is taken gets a numeric suffix; an existing plan is never overwritten', async ($, on) => {
    const r = rig(on);
    r.files.set(PLAN_FILE(), 'older plan');
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect(r.files.get(PLAN_FILE())).toBe('older plan');
    expect(r.files.get(PLAN_FILE().replace('.md', '-2.md'))).toBe(PLAN);
    expect(r.fills[0]?.text).toContain('-2.md');
  });

  test('when every numbered name is taken, nothing is written over and the context is kept', async ($, on) => {
    const r = rig(on);
    r.files.set(PLAN_FILE(), 'older plan');
    for (let i = 2; i <= 20; i += 1) r.files.set(PLAN_FILE().replace('.md', `-${i}.md`), `older plan ${i}`);
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect(r.files.get(PLAN_FILE().replace('.md', '-20.md'))).toBe('older plan 20');
    expect(r.commands).toEqual([]);
    expect(r.fills).toEqual([]);
    expect(r.toasts.at(-1)).toContain('already exists');
  });

  test('no plan text in the result: the file ExitPlanMode saved it to is read', async ($, on) => {
    const r = rig(on);
    r.files.set('/home/u/.claude/plans/x.md', PLAN);
    await planned($, r, null);
    expect(r.banner?.data.plan).toBe(PLAN);
  });

  test('no plan anywhere: the button says so and does nothing', async ($, on) => {
    const r = rig(on);
    await planned($, r, null);
    expect(r.banner?.scenario).toBe('S2b');
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect(r.commands).toEqual([]);
    expect(r.files.size).toBe(0);
    expect(r.fills).toEqual([]);
    expect(r.toasts.at(-1)).toBe('No plan text found: nothing to save');
    expect(r.banner?.scenario).toBe('S2b');
  });

  test('[Continue on Opus] closes it and changes nothing', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'continue' });
    expect(r.banner).toBeNull();
    expect(r.commands).toEqual([]);
    expect(r.files.size).toBe(0);
  });

  test('a failing write: nothing is cleared and the banner stays', async ($, on) => {
    const r = rig(on, { throwOn: ['fs.write'] });
    await planned($, r);
    const ui = await mountBand($);
    await ui.press({ key: 'handoff' });
    expect(r.commands).toEqual([]);
    expect(r.fills).toEqual([]);
    expect(r.banner?.scenario).toBe('S2b');
    expect(r.ledger?.handoff ?? null).toBeNull();
  });

  test('not for a subagent\'s ExitPlanMode, a failed one, or a plan awaiting a leader', async ($, on) => {
    const r = rig(on);
    await start($);
    r.results.ExitPlanMode = { plan: PLAN };
    await $.tool.call({ tool: 'ExitPlanMode', agentId: 'a1' } as never);
    expect(r.banner ?? null).toBeNull();
    r.results.ExitPlanMode = { plan: PLAN, awaitingLeaderApproval: true };
    await $.tool.call({ tool: 'ExitPlanMode' } as never);
    expect(r.banner ?? null).toBeNull();
    r.toolIsError = true;
    await $.tool.call({ tool: 'ExitPlanMode' } as never);
    expect(r.banner ?? null).toBeNull();
  });

  test('suggestions off and quality: no banner', { options: { suggestions: 'off' } }, async ($, on) => {
    const r = rig(on);
    await planned($, r);
    expect(r.banner ?? null).toBeNull();
  });

  test('the "orchestra" variant is there only when orchestrator mode was fixed at session start', { options: { orchestrate: 'on' } }, async ($, on) => {
    const r = rig(on);
    await planned($, r);
    expect(r.banner?.actions.map((a) => a.key)).toEqual(['handoff', 'continue', 'orchestra', 'never']);
    const ui = await mountBand($);
    await ui.press({ key: 'orchestra' });
    // Opus stays, nothing is cleared; the prompt box gets a delegation hint for the person to send.
    expect(r.commands).toEqual([]);
    expect(r.fills[0]?.text).toContain('agento-builder');
    expect(r.submitted.map((s) => s.text)).toEqual([HEAVY]);
  });

  test('S2 outranks S1 on the band; S7 outranks S2', async ($, on) => {
    const r = rig(on);
    await planned($, r);
    expect(r.banner?.scenario).toBe('S2b');
    r.toolIsError = true;
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Read', file_path: '/nope' });
    expect(r.banner?.scenario).toBe('S7');
    r.toolIsError = false;
    r.results.ExitPlanMode = { plan: PLAN };
    await $.tool.call({ tool: 'ExitPlanMode' } as never);
    expect(r.banner?.scenario).toBe('S7');
  });
});

