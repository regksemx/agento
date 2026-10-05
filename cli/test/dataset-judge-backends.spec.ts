import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeArgs, claudeBackend, parseClaudeOutput, type SpawnFn } from '../src/dataset/judge/claude.ts';
import { datasetJudgeCmd } from '../src/dataset/judge/command.ts';
import { buildRequestBody, chatUrl, openAiBackend } from '../src/dataset/judge/openai.ts';
import { JUDGE_JSON_SCHEMA, PROMPT_VERSION } from '../src/dataset/judge/prompt.ts';
import { readJudgeFile } from '../src/dataset/judge/store.ts';
import { BackendError } from '../src/dataset/judge/types.ts';
import type { TaskRecord } from '../src/dataset/types.ts';

const VERDICT = { rationale: 'Simple.', probs: { 'haiku-low': 0.4, 'sonnet-medium': 0.85, 'sonnet-high': 0.9, 'opus-medium': 0.95 }, needsPlanFirst: false, delegateExplore: false, difficulty: 2 };
const prompt = { system: 'SYS', user: 'USER' };

function taskRec(id: string, text = 'rename foo to bar'): TaskRecord {
  return {
    v: 1,
    taskId: id,
    project: '~/Projects/demo',
    startTs: 1,
    text: [text],
    context: { contextTokensAtStart: 1000, startKind: 'first-prompt', languages: ['ts'], hasGitBranch: true, prevTaskWasHeavy: false },
    observed: { model: 'claude-opus-5-5', modelTier: 'opus', mainCalls: 5, subagentCalls: 0, subagentTypes: [], filesEdited: 1, linesChanged: 4, toolErrors: 0, testRuns: 0, testFailures: 0, sameEditRepeats: 0, userCorrections: 0, userInterrupts: 0, planMode: false, durationMs: 1000, outputTokens: 100, cost: 1 },
    difficulty: 0.2,
    l0Tier: 'sonnet',
    l0Effort: 'medium',
    rulesVerdict: { tier: 'sonnet', effort: 'medium', confidence: 0.5, reasons: [] },
    labelSource: 'L0',
  };
}

function writeHome(ids: Array<[string, string]>): string {
  const home = mkdtempSync(join(tmpdir(), 'agento-home-'));
  mkdirSync(join(home, 'dataset'), { recursive: true });
  writeFileSync(join(home, 'dataset', 'tasks.jsonl'), ids.map(([id, text]) => JSON.stringify(taskRec(id, text))).join('\n') + '\n');
  return home;
}

// ───────────── openai backend against a local node:http server ─────────────

interface Seen {
  headers: IncomingMessage['headers'];
  url: string;
  body: Record<string, any>;
}

describe('openai backend (local mock server)', () => {
  let server: Server;
  let base: string;
  let seen: Seen[];
  let handler: (n: number, res: ServerResponse) => void;
  const dirs: string[] = [];

  beforeEach(async () => {
    seen = [];
    handler = (_n, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'served-model', choices: [{ message: { content: JSON.stringify(VERDICT) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    };
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, url: req.url ?? '', body: JSON.parse(data || '{}') });
        handler(seen.length, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const make = (o: Partial<Parameters<typeof openAiBackend>[0]> = {}) =>
    openAiBackend({ baseUrl: base, model: 'm', structured: false, timeoutMs: 2000, retries: 2, backoffMs: 1, sleep: async () => undefined, ...o });

  it('unstructured: sends a plain chat request without response_format and returns text and usage', async () => {
    const c = await make({ apiKey: 'sekret' }).complete(prompt);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBe('Bearer sekret');
    expect(seen[0]!.body.model).toBe('m');
    expect(seen[0]!.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(seen[0]!.body.temperature).toBe(0);
    expect(seen[0]!.body.response_format).toBeUndefined();
    expect(JSON.parse(c.text)).toEqual(VERDICT);
    expect(c.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(c.resolvedModel).toBe('served-model');
  });

  it('structured: sends response_format json_schema with the judge schema', async () => {
    await make({ structured: true }).complete(prompt);
    const rf = seen[0]!.body.response_format;
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toBe('agento_judge');
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toEqual(JSON.parse(JSON.stringify(JUDGE_JSON_SCHEMA)));
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('retries 5xx and 429 with exponential backoff, then succeeds', async () => {
    handler = (n, res) => {
      if (n === 1) return void res.writeHead(503).end('busy');
      if (n === 2) return void res.writeHead(429).end('slow down');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    };
    const sleeps: number[] = [];
    const c = await make({ backoffMs: 100, sleep: async (ms) => void sleeps.push(ms) }).complete(prompt);
    expect(c.text).toBe('ok');
    expect(seen).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it('gives up after the configured retries', async () => {
    handler = (_n, res) => void res.writeHead(500).end('boom');
    await expect(make({ retries: 1 }).complete(prompt)).rejects.toThrow(/HTTP 500/);
    expect(seen).toHaveLength(2);
  });

  it('does not retry a 4xx', async () => {
    handler = (_n, res) => void res.writeHead(401).end('nope');
    const err = await make().complete(prompt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).retryable).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('times out a hanging request', async () => {
    handler = () => undefined; // never answers
    await expect(make({ timeoutMs: 50, retries: 0 }).complete(prompt)).rejects.toThrow(/timeout/);
  });

  it('reports a connection failure as a retryable backend error', async () => {
    const err = await make({ baseUrl: 'http://127.0.0.1:9/v1', retries: 0 }).complete(prompt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).retryable).toBe(true);
  });

  it('builds the chat url from any base', () => {
    expect(chatUrl('http://h:8000/v1')).toBe('http://h:8000/v1/chat/completions');
    expect(chatUrl('http://h:8000/v1/')).toBe('http://h:8000/v1/chat/completions');
    expect(chatUrl('http://h/v1/chat/completions')).toBe('http://h/v1/chat/completions');
    expect(buildRequestBody('m', prompt, false)).not.toHaveProperty('response_format');
  });

  it('command: judges tasks.jsonl end to end, writes the file, prints the summary; a second run skips everything', async () => {
    const home = writeHome([['aaaa', 'one task'], ['bbbb', 'other task']]);
    dirs.push(home);
    let out = '';
    const deps = { env: { AGENTO_HOME: home, MY_KEY: 'k' }, stdout: { write: (s: string) => void (out += s), columns: 80 }, stderr: { write: () => true } };
    const flags = new Map<string, string | true>([['backend', 'openai'], ['base-url', base], ['model', 'vllm/test'], ['structured', true], ['api-key-env', 'MY_KEY'], ['no-color', true]]);
    expect(await datasetJudgeCmd(flags, 'en', deps)).toBe(0);
    const file = join(home, 'dataset', 'judge', 'openai-vllm_test.jsonl');
    const recs = readJudgeFile(file);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ ok: true, l1Tier: 'sonnet', l1Effort: 'medium', promptVersion: PROMPT_VERSION, judgeModel: 'vllm/test' });
    expect(out).toContain('judged');
    expect(out).toContain('L1 is unvalidated');
    expect(seen.every((s) => s.headers.authorization === 'Bearer k')).toBe(true);

    const n = seen.length;
    expect(await datasetJudgeCmd(flags, 'en', deps)).toBe(0);
    expect(seen).toHaveLength(n);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);

    out = '';
    expect(await datasetJudgeCmd(new Map([...flags, ['dry-run', true]]), 'en', deps)).toBe(0);
    expect(out).toContain('Nothing to judge');
    expect(seen).toHaveLength(n);
  });

  it('command: fails early when --api-key-env points at an empty variable', async () => {
    const home = writeHome([['aaaa', 'x']]);
    dirs.push(home);
    const flags = new Map<string, string | true>([['backend', 'openai'], ['base-url', base], ['model', 'm'], ['api-key-env', 'NOPE']]);
    await expect(datasetJudgeCmd(flags, 'en', { env: { AGENTO_HOME: home }, stdout: { write: () => true }, stderr: { write: () => true } })).rejects.toThrow(/NOPE/);
    expect(seen).toHaveLength(0);
  });
});

// ───────────── claude backend: command construction with a mocked child_process ─────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (s: string) => void; end: () => void; on: () => void; written: string };
  kill: (sig?: string) => void;
}
interface SpawnCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string };
  child: FakeChild;
}

function fakeSpawn(script: (child: FakeChild) => void): { spawnFn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnFn = ((cmd: string, args: string[], opts: { cwd?: string }) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      written: '',
      write(s) {
        this.written += s;
      },
      end() {
        setImmediate(() => script(child));
      },
      on() {},
    };
    child.kill = () => void child.emit('close', null);
    calls.push({ cmd, args, opts, child });
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, calls };
}

const claudeJson = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 80 },
    modelUsage: { 'claude-haiku-4-5': {} },
    ...extra,
  });

describe('claude backend (mocked child_process, claude is never run)', () => {
  it('builds `claude -p --model <m> --output-format json`, system via flag, user prompt on stdin', async () => {
    const { spawnFn, calls } = fakeSpawn((c) => {
      c.stdout.emit('data', Buffer.from(claudeJson(JSON.stringify(VERDICT))));
      c.emit('close', 0);
    });
    const c = await claudeBackend({ model: 'haiku', timeoutMs: 1000, spawnFn }).complete(prompt);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('claude');
    const a = calls[0]!.args;
    expect(a.slice(0, 6)).toEqual(['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence']);
    expect(a).toEqual(claudeArgs('haiku', 'SYS'));
    expect(a[a.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).not.toContain('USER'); // the task goes on stdin, not argv
    expect(calls[0]!.child.stdin.written).toBe('USER');
    expect(calls[0]!.opts.cwd).toBe(tmpdir());
    expect(JSON.parse(c.text)).toEqual(VERDICT);
    expect(c.usage).toEqual({ inputTokens: 1510, outputTokens: 80, costUsd: 0.0123 });
    expect(c.resolvedModel).toBe('claude-haiku-4-5');
  });

  it('turns a non-zero exit, an error result and bad output into backend errors', async () => {
    const exit = fakeSpawn((c) => {
      c.stderr.emit('data', Buffer.from('rate limited'));
      c.emit('close', 1);
    });
    await expect(claudeBackend({ model: 'opus', timeoutMs: 1000, spawnFn: exit.spawnFn }).complete(prompt)).rejects.toThrow(/code 1: rate limited/);
    expect(() => parseClaudeOutput(claudeJson('limit reached', { is_error: true }))).toThrow(/limit reached/);
    expect(() => parseClaudeOutput('not json')).toThrow(BackendError);
    expect(() => parseClaudeOutput(JSON.stringify({ type: 'result' }))).toThrow(/no result/);
  });

  it('kills the process on timeout', async () => {
    const { spawnFn } = fakeSpawn(() => undefined);
    await expect(claudeBackend({ model: 'sonnet', timeoutMs: 20, spawnFn }).complete(prompt)).rejects.toThrow(/timeout/);
  });

  describe('through the command', () => {
    const dirs: string[] = [];
    afterEach(() => void dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

    const setup = () => {
      const home = writeHome([['cc', 'task c'], ['aa', 'task a'], ['bb', 'task b']]);
      dirs.push(home);
      let out = '';
      let err = '';
      const mk = (confirm?: (q: string) => Promise<boolean>, interactive = true) => {
        const sp = fakeSpawn((c) => {
          c.stdout.emit('data', Buffer.from(claudeJson(JSON.stringify(VERDICT))));
          c.emit('close', 0);
        });
        const deps = { env: { AGENTO_HOME: home }, stdout: { write: (s: string) => void (out += s), columns: 80 }, stderr: { write: (s: string) => void (err += s) }, spawnFn: sp.spawnFn, confirm, interactive };
        return { sp, deps };
      };
      return { home, mk, out: () => out, err: () => err };
    };
    const flags = (o: Record<string, string | true>) => new Map<string, string | true>([['backend', 'claude'], ['model', 'haiku'], ['no-color', true], ...Object.entries(o)]);

    it('prints the estimate, asks, and spawns nothing when declined', async () => {
      const s = setup();
      const { sp, deps } = s.mk(async () => false);
      expect(await datasetJudgeCmd(flags({ 'max-tasks': '2' }), 'en', deps)).toBe(1);
      expect(sp.calls).toHaveLength(0);
      expect(s.out()).toContain('This spends your Claude subscription limit');
      expect(s.out()).toContain('to judge: 2 of 3 tasks');
      expect(s.err()).toContain('Cancelled');
    });

    it('refuses without a terminal and without --yes', async () => {
      const s = setup();
      const { sp, deps } = s.mk(undefined, false);
      expect(await datasetJudgeCmd(flags({ 'max-tasks': '2' }), 'en', deps)).toBe(1);
      expect(sp.calls).toHaveLength(0);
      expect(s.err()).toContain('--yes');
    });

    it('--yes skips the question; only --max-tasks tasks are judged; cost is reported', async () => {
      const s = setup();
      let asked = false;
      const { sp, deps } = s.mk(async () => ((asked = true), true));
      expect(await datasetJudgeCmd(flags({ 'max-tasks': '2', yes: true }), 'en', deps)).toBe(0);
      expect(asked).toBe(false);
      expect(sp.calls).toHaveLength(2);
      expect(readJudgeFile(join(s.home, 'dataset', 'judge', 'claude-haiku.jsonl'))).toHaveLength(2);
      expect(s.out()).toContain('API-equivalent cost');
    });

    it('dry run never spawns', async () => {
      const s = setup();
      const { sp, deps } = s.mk();
      expect(await datasetJudgeCmd(flags({ 'dry-run': true }), 'en', deps)).toBe(0);
      expect(sp.calls).toHaveLength(0);
      expect(s.out()).toContain('at API prices');
      expect(s.out()).toContain('requires --max-tasks');
    });
  });
});
