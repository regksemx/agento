import { describe, expect, it } from 'vitest';
import { LoopGuard, normalizeCommand, type ToolEvent } from './loop-guard.ts';

let clock = 0;
const ev = (o: Partial<ToolEvent> & { tool: string }): ToolEvent => ({ input: {}, isError: false, at: clock++, lineage: 'main', ...o });
const bash = (command: string, isError = false, lineage = 'main') => ev({ tool: 'Bash', input: { command }, isError, lineage });
const edit = (file_path: string, old_string: string, new_string: string, isError = false, lineage = 'main') =>
  ev({ tool: 'Edit', input: { file_path, old_string, new_string }, isError, lineage });
const read = (lineage = 'main') => ev({ tool: 'Read', input: { file_path: '/a' }, lineage });

describe('failing-test', () => {
  it('signals on the third consecutive failure of the same test command', () => {
    const g = new LoopGuard();
    expect(g.push(bash('npx vitest run auth.spec', true))).toBeNull();
    expect(g.push(bash('npx vitest run auth.spec', true))).toBeNull();
    const s = g.push(bash('npx vitest run auth.spec', true));
    expect(s).toEqual({ kind: 'failing-test', count: 3, detail: 'npx vitest run auth.spec' });
  });

  it('other tools between the runs do not break the run (the agent edits in between)', () => {
    const g = new LoopGuard();
    g.push(bash('pytest -x', true));
    g.push(edit('/a.py', 'a', 'b'));
    g.push(bash('pytest -x', true));
    g.push(read());
    expect(g.push(bash('pytest -x', true))?.kind).toBe('failing-test');
  });

  it('a pass resets the count', () => {
    const g = new LoopGuard();
    g.push(bash('cargo test', true));
    g.push(bash('cargo test', true));
    g.push(bash('cargo test', false));
    expect(g.push(bash('cargo test', true))).toBeNull();
    expect(g.push(bash('cargo test', true))).toBeNull();
    expect(g.push(bash('cargo test', true))?.count).toBe(3);
  });

  it('different commands are counted separately', () => {
    const g = new LoopGuard();
    g.push(bash('npm test -- a', true));
    g.push(bash('npm test -- b', true));
    expect(g.push(bash('npm test -- c', true))).toBeNull();
  });

  it('normalizes whitespace, cd prefix, redirects and tail', () => {
    expect(normalizeCommand('  cd /x && npm   test  2>&1 | tail -20 ')).toBe('npm test');
    expect(normalizeCommand('npm test > /tmp/out.txt')).toBe('npm test');
    const g = new LoopGuard();
    g.push(bash('npm test', true));
    g.push(bash('cd /repo && npm test 2>&1 | tail -30', true));
    expect(g.push(bash('npm  test', true))?.kind).toBe('failing-test');
  });

  it.each([
    'pytest', 'python -m pytest tests/', 'npx jest', 'npx vitest run', 'go test ./...', 'cargo test --lib', 'mvn test', 'gradle build', './gradlew test',
    'npm test', 'npm run test:unit', 'yarn test', 'make test',
  ])('recognises %s as a test command', (cmd) => {
    const g = new LoopGuard();
    g.push(bash(cmd, true));
    g.push(bash(cmd, true));
    expect(g.push(bash(cmd, true))?.kind).toBe('failing-test');
  });

  it.each(['ls -la', 'git status', 'node build.js', 'echo contest', 'cat latest.log'])('ignores %s', (cmd) => {
    const g = new LoopGuard();
    g.push(bash(cmd, true));
    g.push(bash(cmd, true));
    expect(g.push(bash(cmd, true))?.kind).not.toBe('failing-test');
  });

  it('ignores non-Bash tools and malformed input', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 5; i++) expect(g.push(ev({ tool: 'Read', input: { command: 'npm test' }, isError: false }))).toBeNull();
    expect(g.push(ev({ tool: 'Bash', input: null, isError: true }))).toBeNull();
    expect(g.push(ev({ tool: 'Bash', input: 'x' as unknown, isError: true }))).toBeNull();
  });
});

describe('same-edit', () => {
  it('signals on the third edit of the same place', () => {
    const g = new LoopGuard();
    expect(g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'))).toBeNull();
    expect(g.push(edit('/a.ts', 'return bar(x)', 'return baz(x)'))).toBeNull();
    const s = g.push(edit('/a.ts', 'return baz(x)', 'return foo(x)'));
    expect(s).toEqual({ kind: 'same-edit', count: 3, detail: '/a.ts' });
  });

  it('same old_string three times (failed edits) also counts', () => {
    const g = new LoopGuard();
    g.push(edit('/a.ts', 'const retries = 3', 'const retries = 5', true));
    g.push(edit('/a.ts', 'const retries = 3', 'const retries = 5', true));
    expect(g.push(edit('/a.ts', 'const retries = 3', 'const retries = 5', true))?.kind).toBe('same-edit');
  });

  it('containment of old_string counts as overlap', () => {
    const g = new LoopGuard();
    g.push(edit('/a.ts', 'function f() {\n  return 1\n}', 'function f() {\n  return 2\n}'));
    g.push(edit('/a.ts', '  return 2', '  return 3'));
    expect(g.push(edit('/a.ts', 'function f() {\n  return 3\n}', 'function f() {\n  return 4\n}'))?.kind).toBe('same-edit');
  });

  it('different places in the same file do not count', () => {
    const g = new LoopGuard();
    g.push(edit('/a.ts', 'import { a } from "a"', 'import { a, b } from "a"'));
    g.push(edit('/a.ts', 'export function render() {', 'export async function render() {'));
    expect(g.push(edit('/a.ts', 'const timeout = 1000', 'const timeout = 2000'))).toBeNull();
  });

  it('different files do not count', () => {
    const g = new LoopGuard();
    g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'));
    g.push(edit('/b.ts', 'return foo(x)', 'return bar(x)'));
    expect(g.push(edit('/c.ts', 'return foo(x)', 'return bar(x)'))).toBeNull();
  });

  it('edits more than 10 steps apart do not count', () => {
    const g = new LoopGuard();
    g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'));
    g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'));
    for (let i = 0; i < 9; i++) g.push(read());
    expect(g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'))).toBeNull();
  });

  it('three edits within exactly 10 steps do count', () => {
    const g = new LoopGuard();
    g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'));
    for (let i = 0; i < 4; i++) g.push(read());
    g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'));
    for (let i = 0; i < 3; i++) g.push(read());
    expect(g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'))?.kind).toBe('same-edit');
  });

  it('Write counts as touching the whole file', () => {
    const g = new LoopGuard();
    g.push(ev({ tool: 'Write', input: { file_path: '/a.ts', content: 'x' } }));
    g.push(edit('/a.ts', 'return foo(x)', 'return bar(x)'));
    expect(g.push(ev({ tool: 'Write', input: { file_path: '/a.ts', content: 'y' } }))?.kind).toBe('same-edit');
  });

  it('MultiEdit is read from its edits', () => {
    const g = new LoopGuard();
    const me = () => ev({ tool: 'MultiEdit', input: { file_path: '/a.ts', edits: [{ old_string: 'return foo(x)', new_string: 'return bar(x)' }] } });
    g.push(me());
    g.push(me());
    expect(g.push(me())?.kind).toBe('same-edit');
  });

  it('tiny shared strings do not count', () => {
    const g = new LoopGuard();
    g.push(edit('/a.ts', 'a', 'ab'));
    g.push(edit('/a.ts', 'x', 'xy'));
    expect(g.push(edit('/a.ts', 'q', 'qr'))).toBeNull();
  });

  it('edits without file path are ignored', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 5; i++) expect(g.push(ev({ tool: 'Edit', input: { old_string: 'return foo(x)', new_string: 'b' } }))).toBeNull();
  });
});

describe('error-streak', () => {
  it('signals on the 4th consecutive error of any tools', () => {
    const g = new LoopGuard();
    expect(g.push(ev({ tool: 'Read', isError: true }))).toBeNull();
    expect(g.push(ev({ tool: 'Bash', input: { command: 'ls' }, isError: true }))).toBeNull();
    expect(g.push(ev({ tool: 'Grep', isError: true }))).toBeNull();
    expect(g.push(ev({ tool: 'Read', isError: true }))).toEqual({ kind: 'error-streak', count: 4, detail: 'Read' });
  });

  it('a success resets the streak', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 3; i++) g.push(ev({ tool: 'Read', isError: true }));
    g.push(ev({ tool: 'Read' }));
    for (let i = 0; i < 3; i++) expect(g.push(ev({ tool: 'Read', isError: true }))).toBeNull();
    expect(g.push(ev({ tool: 'Read', isError: true }))?.kind).toBe('error-streak');
  });
});

describe('anti-spam', () => {
  it('one signal per kind and lineage per 10 steps, then again', () => {
    const g = new LoopGuard();
    const fails = () => ev({ tool: 'Read', isError: true });
    const signals: number[] = [];
    for (let step = 1; step <= 30; step++) {
      if (g.push(fails())?.kind === 'error-streak') signals.push(step);
    }
    // First at the 4th event, then every 10 steps while the streak goes on.
    expect(signals).toEqual([4, 14, 24]);
  });

  it('kinds are throttled independently', () => {
    const g = new LoopGuard();
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const s = g.push(bash('npm test', true));
      if (s) kinds.push(s.kind);
    }
    // failing-test at 3 outranks the streak that would fire at 4.
    expect(kinds).toEqual(['failing-test', 'error-streak']);
  });

  it('lineages are independent', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 3; i++) g.push(ev({ tool: 'Read', isError: true, lineage: 'main' }));
    for (let i = 0; i < 3; i++) expect(g.push(ev({ tool: 'Read', isError: true, lineage: 'agent:x' }))).toBeNull();
    expect(g.push(ev({ tool: 'Read', isError: true, lineage: 'agent:x' }))?.kind).toBe('error-streak');
    expect(g.push(ev({ tool: 'Read', isError: true, lineage: 'main' }))?.kind).toBe('error-streak');
  });

  it('an error in a subagent does not extend the main streak', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 3; i++) g.push(ev({ tool: 'Read', isError: true }));
    g.push(ev({ tool: 'Read', isError: true, lineage: 'agent:x' }));
    expect(g.push(ev({ tool: 'Read', isError: true }))?.kind).toBe('error-streak');
  });
});

describe('reset', () => {
  it('reset(lineage) clears only that lineage', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 3; i++) g.push(ev({ tool: 'Read', isError: true }));
    for (let i = 0; i < 3; i++) g.push(ev({ tool: 'Read', isError: true, lineage: 'agent:x' }));
    g.reset('agent:x');
    expect(g.push(ev({ tool: 'Read', isError: true, lineage: 'agent:x' }))).toBeNull();
    expect(g.push(ev({ tool: 'Read', isError: true }))?.kind).toBe('error-streak');
  });

  it('reset() clears everything including the cooldown', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 4; i++) g.push(ev({ tool: 'Read', isError: true }));
    g.reset();
    for (let i = 0; i < 3; i++) expect(g.push(ev({ tool: 'Read', isError: true }))).toBeNull();
    expect(g.push(ev({ tool: 'Read', isError: true }))?.kind).toBe('error-streak');
  });
});
