import { describe, expect, test } from 'claude-code/testing';
import { OPUS, prompt, rig, step } from './rig.ts';

const big = (c: string) => c.repeat(20_000);

// The same file read twice and the same test run twice, then a few recent messages.
function transcript(): unknown[] {
  const m: unknown[] = [
    { role: 'user', text: 'fix the parser', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/p.ts' } }, { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: big('a'), isError: false }, { tool_use_id: 'b1', text: big('F'), isError: true }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r2', tool: 'Read', input: { file_path: '/p.ts' } }, { tool_use_id: 'b2', tool: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r2', text: big('b'), isError: false }, { tool_use_id: 'b2', text: big('P'), isError: false }] },
  ];
  for (let i = 0; i < 12; i++) m.push({ role: i % 2 ? 'user' : 'assistant', text: `m${i}`, toolUses: [] });
  return m;
}

const start = ($: any) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });

async function compact($: any, trigger: string, agentId?: string): Promise<void> {
  await start($);
  await prompt($, 'Добавь тесты для парсера конфигурации и обработку ошибок');
  await step($, { model: OPUS });
  await $.session.compact({ trigger, messages: transcript(), ...(agentId ? { agentId } : {}) } as never);
}

type Sent = Array<{ toolResults?: Array<{ text: string }> }>;

describe('pruning stale outputs before a compaction', () => {
  test('/compact: the summarizer gets the transcript without the superseded outputs', async ($, on) => {
    const r = rig(on, { auth: 'bearer' });
    await compact($, 'manual');
    const sent = r.compactions[0]?.messages as Sent;
    expect(sent[2]?.toolResults?.map((x) => x.text.slice(0, 8))).toEqual(['[agento:', '[agento:']);
    expect(sent[4]?.toolResults?.[0]?.text).toBe(big('b'));
    expect(r.ledger?.pruned).toEqual({ count: 1, outputs: 2, tokens: expect.any(Number) });
    expect(r.ledger?.savedEstimate.prune).toBeGreaterThan(0);
    expect(r.toasts.at(-1)).toMatch(/^agento: pruned 2 stale outputs before compacting \(−\d+k tokens\) · ≈\$0\.\d\d$/);
  });

  test('the automatic compaction too', async ($, on) => {
    const r = rig(on, { auth: 'api-key' });
    await compact($, 'auto');
    expect(r.ledger?.pruned?.outputs).toBe(2);
  });

  test('a precompute or a subagent\'s compaction is left alone', async ($, on) => {
    const r = rig(on, { auth: 'api-key' });
    await compact($, 'precompute');
    await $.session.compact({ trigger: 'manual', agentId: 'ag1', messages: transcript() } as never);
    expect((r.compactions[0]?.messages as Sent)[2]?.toolResults?.[0]?.text).toBe(big('a'));
    expect((r.compactions[1]?.messages as Sent)[2]?.toolResults?.[0]?.text).toBe(big('a'));
    expect(r.ledger?.pruned).toBeUndefined();
  });

  test('a vetoed compaction credits nothing', async ($, on) => {
    const r = rig(on, { auth: 'api-key', compactSkip: true });
    await compact($, 'manual');
    expect(r.ledger?.pruned).toBeUndefined();
  });

  test('off: the transcript goes down as it came', { options: { prune: 'off' } }, async ($, on) => {
    const r = rig(on, { auth: 'api-key' });
    await compact($, 'manual');
    expect((r.compactions[0]?.messages as Sent)[2]?.toolResults?.[0]?.text).toBe(big('a'));
  });
});
