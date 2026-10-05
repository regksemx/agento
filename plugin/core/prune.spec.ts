import { describe, expect, it } from 'vitest';
import { compactPruneSaving, planPrune, stubText, supersedeKey, type PruneMessage } from './prune.ts';

const big = (c: string) => c.repeat(2000);

// same read and same command twice, plus optional recent filler
function convo(extraRecent = 0): PruneMessage[] {
  const m: PruneMessage[] = [
    { role: 'user', text: 'fix it', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }, { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test' } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: big('a'), isError: false }, { tool_use_id: 'b1', text: big('F'), isError: true }], handle: 'h2' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r2', tool: 'Read', input: { file_path: '/a.ts' } }, { tool_use_id: 'b2', tool: 'Bash', input: { command: ' npm test ' } }], handle: 'h3' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r2', text: big('b'), isError: false }, { tool_use_id: 'b2', text: big('P'), isError: false }], handle: 'h4' },
  ];
  for (let i = 0; i < extraRecent; i++) m.push({ role: i % 2 ? 'user' : 'assistant', text: `m${i}`, toolUses: [], handle: `x${i}` });
  return m;
}

describe('supersedeKey', () => {
  it('reads key on path and range, commands on their trimmed text', () => {
    expect(supersedeKey({ tool_use_id: '1', tool: 'Read', input: { file_path: '/a', offset: 10 } })).toBe('read:/a:10:');
    expect(supersedeKey({ tool_use_id: '1', tool: 'Bash', input: { command: ' ls ' } })).toBe('bash:ls');
    expect(supersedeKey({ tool_use_id: '1', tool: 'Edit', input: { file_path: '/a' } })).toBeNull();
    expect(supersedeKey({ tool_use_id: '1', tool: 'Bash', input: {} })).toBeNull();
  });
});

describe('planPrune', () => {
  it('stubs the older of two identical calls and keeps the newer', () => {
    const p = planPrune(convo(), 0);
    expect(p.pruned).toBe(2);
    expect(p.messages[2]?.toolResults?.map((r) => r.text)).toEqual([stubText('Read'), stubText('Bash')]);
    expect(p.messages[4]?.toolResults?.[0]?.text).toBe(big('b'));
    expect(p.chars).toBe(4000 - stubText('Read').length - stubText('Bash').length);
  });
  it('a changed message loses its handle; the others keep theirs, untouched', () => {
    const src = convo();
    const p = planPrune(src, 0);
    expect(p.messages[2]?.handle).toBeUndefined();
    expect(p.messages[1]).toBe(src[1]);
    expect(p.messages[4]).toBe(src[4]);
  });
  it('never touches the newest messages', () => {
    expect(planPrune(convo(), 5).pruned).toBe(0);
    expect(planPrune(convo(8), 12).pruned).toBe(0);
    expect(planPrune(convo(12), 12).pruned).toBe(2);
  });
  it('short outputs and outputs already stubbed are left alone', () => {
    const m = convo();
    const short = m.map((x) => (x.toolResults ? { ...x, toolResults: x.toolResults.map((r) => ({ ...r, text: 'tiny' })) } : x));
    expect(planPrune(short, 0).pruned).toBe(0);
    const once = planPrune(m, 0).messages;
    expect(planPrune(once, 0).pruned).toBe(0);
  });
  it('different ranges of one file are different calls', () => {
    const m = convo();
    m[3] = { ...m[3]!, toolUses: [{ tool_use_id: 'r2', tool: 'Read', input: { file_path: '/a.ts', offset: 200 } }, m[3]!.toolUses[1]!] };
    expect(planPrune(m, 0).pruned).toBe(1);
  });
});

describe('savings', () => {
  it('before a compaction the summarizer reads the removed tokens as input', () => {
    expect(compactPruneSaving('claude-opus-5-5', 10_000)).toBeCloseTo(0.04, 6);
    expect(compactPruneSaving('mystery', 10_000)).toBeNull();
  });
});
