import { describe, expect, it } from 'vitest';
import { analyzeTasks, segmentTasks } from '../src/audit/tasks.ts';
import { call, corpus, marker, MIN, prompt, session, step, T0, toolResult } from './corpus-builder.ts';

const edit = (path: string, name = 'Edit') => ({ id: `tu_${path}`, name, input: { file_path: path } });

describe('segmentTasks', () => {
  it('starts tasks at the first prompt, after /clear or compaction, and after 30+ min idle', () => {
    const s = session({
      prompts: [
        prompt('first task', T0),
        prompt('same task, follow-up', T0 + 5 * MIN),
        prompt('/clear', T0 + 6 * MIN),
        prompt('after clear', T0 + 7 * MIN),
        prompt('after compaction', T0 + 12 * MIN),
        prompt('after a long break', T0 + 60 * MIN),
        prompt('/model sonnet', T0 + 61 * MIN),
      ],
      markers: [marker('clear', T0 + 6 * MIN), marker('compact', T0 + 10 * MIN)],
      calls: [
        step(T0 + 1 * MIN, 1000),
        step(T0 + 6 * MIN, 1000),
        step(T0 + 8 * MIN, 1000),
        step(T0 + 13 * MIN, 1000),
        step(T0 + 14 * MIN, 1000),
        step(T0 + 62 * MIN, 1000),
      ],
    });
    const tasks = segmentTasks(s);
    expect(tasks.map((t) => [t.firstPrompt, t.mainCalls])).toEqual([
      ['first task', 2],
      ['after clear', 1],
      ['after compaction', 2],
      ['after a long break', 1],
    ]);
    expect(tasks[0]).toMatchObject({ startTs: T0, endTs: T0 + 6 * MIN });
  });

  it('a gap of exactly 30 minutes is not a boundary', () => {
    const s = session({
      prompts: [prompt('a', T0), prompt('b', T0 + 31 * MIN)],
      calls: [step(T0 + MIN, 1000), step(T0 + 31 * MIN, 1000)],
    });
    expect(segmentTasks(s)).toHaveLength(1);
  });

  it('computes model, effort, files, output, errors and cost over the window', () => {
    const s = session({
      prompts: [prompt('x'.repeat(300), T0), prompt('next', T0 + 50 * MIN)],
      calls: [
        call({ ts: T0 + 1000, model: 'claude-opus-5-5', effort: 'high', usage: { output_tokens: 500, cache_read_input_tokens: 10_000 }, toolUses: [edit('/a.ts'), edit('/b.ts', 'Write')] }),
        call({ ts: T0 + 2000, model: 'claude-sonnet-5-5', effort: 'high', usage: { output_tokens: 200 }, toolUses: [edit('/a.ts', 'MultiEdit'), { id: 'n', name: 'NotebookEdit', input: { notebook_path: '/n.ipynb' } }, { id: 'r', name: 'Read', input: { file_path: '/r.ts' } }] }),
        call({ ts: T0 + 3000, model: 'claude-opus-5-5', effort: 'max', usage: { output_tokens: 700 } }),
        // subagent work inside the window counts for files, output and cost
        call({ ts: T0 + 4000, lineage: 'agent:x', model: 'claude-haiku-4-5', usage: { output_tokens: 1000 }, toolUses: [edit('/sub.ts')] }),
        step(T0 + 60 * MIN, 1000),
      ],
      toolResults: [toolResult('t1', T0 + 1500, true), toolResult('t2', T0 + 2500, false), toolResult('t3', T0 + 3500, true), toolResult('t4', T0 + 55 * MIN, true)],
    });
    const [t, next] = segmentTasks(s);
    expect(t).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', mainCalls: 3, filesEdited: 4, outputTokens: 2400, errors: 2 });
    expect(t?.firstPrompt).toHaveLength(200);
    // opus: 10k read + 500 out, sonnet: 200 out, opus: 700 out, haiku: 1000 out
    const expected = (10_000 * 0.2 + 500 * 20) / 1e6 + (200 * 10) / 1e6 + (700 * 20) / 1e6 + (1000 * 5) / 1e6;
    expect(t?.cost).toBeCloseTo(expected, 12);
    expect(next?.errors).toBe(1);
  });

  it('applies the light thresholds (<= 8 calls, <= 2 files, <= 6k output)', () => {
    const base = (n: number, files: number, out: number) =>
      session({
        prompts: [prompt('p', T0)],
        calls: Array.from({ length: n }, (_, i) =>
          call({
            ts: T0 + (i + 1) * 1000,
            usage: { output_tokens: i === 0 ? out : 0 },
            toolUses: i === 0 ? Array.from({ length: files }, (_, k) => edit(`/f${k}.ts`)) : [],
          }),
        ),
      });
    expect(segmentTasks(base(8, 2, 6000))[0]?.isLight).toBe(true);
    expect(segmentTasks(base(9, 2, 6000))[0]?.isLight).toBe(false);
    expect(segmentTasks(base(8, 3, 6000))[0]?.isLight).toBe(false);
    expect(segmentTasks(base(8, 2, 6001))[0]?.isLight).toBe(false);
  });

  it('ignores prompts that got no answer and sessions without prompts', () => {
    expect(segmentTasks(session({ calls: [step(T0, 1000)] }))).toEqual([]);
    expect(segmentTasks(session({ prompts: [prompt('lonely', T0)] }))).toEqual([]);
  });
});

describe('analyzeTasks', () => {
  const light = (id: string, t0: number, model: string, effort: string, output: number) => ({
    prompts: [prompt(`task ${id}`, t0)],
    calls: [call({ ts: t0 + 1000, model, effort, usage: { cache_read_input_tokens: 50_000, output_tokens: output } })],
  });

  it('counts light tasks on opus/fable and reprices them as sonnet', () => {
    const o = light('o', T0, 'claude-opus-5-5', 'max', 2000);
    const f = light('f', T0 + 120 * MIN, 'claude-fable-5-1', 'xhigh', 1000);
    const sn = light('s', T0 + 240 * MIN, 'claude-sonnet-5-5', 'max', 500);
    const heavy = {
      prompts: [prompt('big', T0 + 360 * MIN)],
      calls: Array.from({ length: 12 }, (_, i) => call({ ts: T0 + 360 * MIN + (i + 1) * 1000, model: 'claude-opus-5-5', usage: { output_tokens: 100 } })),
    };
    const c = corpus([session({ sessionId: 's1', prompts: [...o.prompts, ...f.prompts, ...sn.prompts, ...heavy.prompts], calls: [...o.calls, ...f.calls, ...sn.calls, ...heavy.calls] })]);
    const r = analyzeTasks(c);

    const opusCost = (50_000 * 0.2 + 2000 * 20) / 1e6;
    const fableCost = (50_000 * 0.25 + 1000 * 50) / 1e6;
    const sonnet = (out: number) => (50_000 * 0.2 + out * 10) / 1e6;
    expect(r.count).toBe(4);
    expect(r.light).toBe(3);
    expect(r.lightOnExpensive.count).toBe(2);
    expect(r.lightOnExpensive.cost).toBeCloseTo(opusCost + fableCost, 12);
    expect(r.lightOnExpensive.asSonnet).toBeCloseTo(sonnet(2000) + sonnet(1000), 12);
    expect(r.maxEffortOnLight).toBe(3);
    expect(r.topExamples.map((t) => t.firstPrompt)).toEqual(['task f', 'task o', 'task s']);
  });

  it('includes subagent calls in the window and keeps at most 5 examples', () => {
    const prompts = [];
    const calls = [];
    for (let i = 0; i < 7; i += 1) {
      const t0 = T0 + i * 120 * MIN;
      prompts.push(prompt(`t${i}`, t0));
      calls.push(call({ ts: t0 + 1000, model: 'claude-opus-5-5', usage: { output_tokens: 100 * (i + 1) } }));
    }
    calls.push(call({ ts: T0 + 1500, lineage: 'agent:z', model: 'claude-opus-5-5', usage: { output_tokens: 1000 } }));
    const r = analyzeTasks(corpus([session({ prompts, calls })]));
    expect(r.topExamples).toHaveLength(5);
    // t0 is the dearest only because its subagent call (1000 output tokens) is counted
    expect(r.topExamples.map((t) => t.firstPrompt)).toEqual(['t0', 't6', 't5', 't4', 't3']);
    expect(r.lightOnExpensive.count).toBe(7);
    expect(r.lightOnExpensive.asSonnet).toBeCloseTo((2800 + 1000) * 10 / 1e6, 12);
  });

  it('truncates long first prompts to 200 chars', () => {
    const r = analyzeTasks(corpus([session({ prompts: [prompt('я'.repeat(500), T0)], calls: [step(T0 + 1000, 1000)] })]));
    expect(r.topExamples[0]?.firstPrompt).toHaveLength(200);
  });
});
