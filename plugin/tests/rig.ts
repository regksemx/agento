import { mock } from 'claude-code/testing';
import type { On, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import type { AgentoBanner, AgentoLedger, AgentoTask } from '../types';

export const T0 = 1_760_000_000_000; // a fixed "now" for the mocked clock
export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5-5';
export const HAIKU = 'claude-haiku-4-5';

export interface RigOptions {
  // The model the session runs on before anything switches it; `/model` and `/effort` moves it.
  model?: string;
  cwd?: string;
  // Slash commands the build offers (`$.command.list`).
  commands?: string[];
  // `$.ui.open` answers `isPlaced: false`.
  narrowPane?: boolean;
  // A compaction a hook beneath vetoes (`{ skip }`).
  compactSkip?: boolean;
  auth?: 'bearer' | 'api-key' | null;
  rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }>;
  lang?: string;
  store?: Record<string, unknown>;
  // Make a call on $ fail, to prove agento fails open: the event's name, `command.run:model` for one command.
  throwOn?: string[];
  // Make a call on $ never answer: the event's name.
  hangOn?: string[];
  // User prompts the conversation already holds (`$.session.turns`): a resumed or continued session has some.
  turns?: number;
  // Environment variables beyond LANG (`$.env.get`); `brain` alone sets HOME so the daemon's default socket is known.
  env?: Record<string, string>;
  // The local classifier daemon: answers each request it is sent. `'hang'` never answers, `'refuse'` fails at once
  // (nobody listening), a string is the raw body of a 200. Without it every call fails as if there were no daemon.
  brain?: (req: HttpCall) => BrainReply;
}

export interface HttpCall {
  url: string;
  method: string;
  socketPath?: string;
  body?: string;
}

export type BrainReply = 'hang' | 'refuse' | string | { status?: number; json: unknown };

// What the test's engine saw beneath agento, and what agento displayed.
export interface Rig {
  // Slash commands agento ran through `$.command.run`, in order, and what `/model` and `/effort` left selected.
  commands: Array<{ command: string; args: string }>;
  model: string;
  effort: string | undefined;
  // Text agento put in the prompt box, files it wrote, settings it changed, turns it aborted, panes it opened.
  fills: Array<{ text: string; mode?: string }>;
  files: Map<string, string>;
  configs: Array<{ key: string; value: unknown }>;
  aborts: string[];
  panes: string[];
  // What reached the bottom of prompt.submit, after every plugin: text and context.
  submitted: Array<{ text: string; context?: readonly string[] }>;
  // Commands the engine registered through `$.command.register`.
  registered: string[];
  clock: ReturnType<typeof mock.clock>;
  statuses: Array<string | undefined>;
  toasts: string[];
  steps: Array<{ model: string; effort: TurnStepInput['effort']; agentId?: string }>;
  spawns: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  // What the bottom of turn.step reports as usage.
  usage: { in: number; out: number; read: number; write: number; model?: string };
  // What the bottom of tool.call answers.
  toolIsError: boolean;
  // What agento wrote to $.store and to its session state.
  store: Map<string, unknown>;
  ledger: AgentoLedger | undefined;
  // The banner above the prompt as last written (null once cleared) and the task state.
  banner: AgentoBanner | null | undefined;
  task: AgentoTask | undefined;
  // Requests that reached the bottom of http.fetch, in order.
  http: HttpCall[];
  // What the bottom of tool.call answers per tool, instead of the plain `ok`: the tool's `result`.
  results: Record<string, unknown>;
}

// Hooks beneath the plugins must be registered before the test first calls `$`.
export function rig(on: On, o: RigOptions = {}): Rig {
  const r: Rig = {
    clock: mock.clock(on, { now: T0 }),
    statuses: [],
    toasts: [],
    steps: [],
    spawns: [],
    tools: [],
    http: [],
    usage: { in: 0, out: 1500, read: 100_000, write: 3000 },
    toolIsError: false,
    store: new Map(),
    ledger: undefined,
    banner: undefined,
    task: undefined,
    results: {},
    commands: [],
    model: o.model ?? OPUS,
    effort: undefined,
    fills: [],
    files: new Map(),
    configs: [],
    aborts: [],
    panes: [],
    submitted: [],
    registered: [],
  };
  // The test's `$` has no store or state of its own to read: the rig keeps what agento wrote.
  const seed = o.store ?? {};
  for (const k of Object.keys(seed)) r.store.set(k, seed[k]);
  on('store.get', async (_$, e, _next) => ({ value: r.store.get(e.key) }));
  on('store.keys', async (_$, _e, _next) => ({ value: [...r.store.keys()] }));
  on('store.delete', async (_$, e, _next) => {
    r.store.delete(e.key);
    return { value: undefined };
  });
  on('store.set', async (_$, e, _next) => {
    boom('store.set');
    if (o.hangOn?.includes('store.set')) await new Promise(() => undefined);
    r.store.set(e.key, JSON.parse(JSON.stringify(e.value)));
    return { value: undefined };
  });
  on('state.set', async (_$, e, next) => {
    boom('state.set');
    const res = await next(e);
    if (res.value?.isSet && e.plugin === 'agento') {
      if (e.key === 'ledger') r.ledger = e.value as AgentoLedger;
      if (e.key === 'banner') r.banner = e.value as AgentoBanner | null;
      if (e.key === 'task') r.task = e.value as AgentoTask;
    }
    return res;
  });
  mock.env(on, { LANG: o.lang ?? 'en_US.UTF-8', ...(o.brain ? { HOME: '/home/u' } : {}), ...(o.env ?? {}) });
  on('http.fetch', async (_$, e, _next) => {
    const call: HttpCall = { url: e.url, method: e.init?.method ?? 'GET', ...(e.init?.socketPath ? { socketPath: e.init.socketPath } : {}), ...(e.init?.body !== undefined ? { body: e.init.body } : {}) };
    r.http.push(call);
    const reply = o.brain ? o.brain(call) : 'refuse';
    if (reply === 'hang') await new Promise(() => undefined);
    if (reply === 'refuse') return { deny: 'connect ENOENT' };
    const status = typeof reply === 'string' ? 200 : (reply.status ?? 200);
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply.json);
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } };
  });
  const boom = (name: string): void => {
    if (o.throwOn?.includes(name)) throw new Error(`boom: ${name}`);
  };

  on('ui.status', async (_$, e, _next) => {
    boom('ui.status');
    r.statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', async (_$, e, _next) => {
    boom('ui.toast');
    r.toasts.push(e.text);
    return { value: undefined };
  });
  on('session.authorize', async (_$, _e, _next) => {
    const kind = o.auth === undefined ? 'api-key' : o.auth;
    return { value: kind === null ? null : { handle: 'h', kind } };
  });
  on('session.usage', async (_$, _e, _next) => {
    boom('session.usage');
    return { value: { startedAt: T0, context: {}, rateLimits: o.rateLimits ?? [] } as never };
  });
  const ALIAS: Record<string, string> = { opus: OPUS, sonnet: SONNET, haiku: HAIKU };
  on('session.turns', async (_$, _e, _next) => ({ value: o.turns ?? 0 }));
  on('session.cwd', async (_$, _e, _next) => ({ value: o.cwd ?? '/work/app' }));
  on('session.model', async (_$, _e, _next) => {
    boom('session.model');
    return { value: r.model };
  });
  on('command.list', async (_$, _e, _next) => ({ value: (o.commands ?? ['plan', 'clear', 'model']).map((name) => ({ name, description: '', source: 'builtin' as never })) }));
  on('command.register', async (_$, e, _next) => {
    r.registered.push(e.name);
    return { value: { command: e.name } };
  });
  on('command.run', async (_$, e, _next) => {
    boom(`command.run:${e.command}`);
    r.commands.push({ command: e.command, args: e.args });
    if (e.command === 'model') r.model = ALIAS[e.args] ?? e.args;
    if (e.command === 'effort') r.effort = e.args;
    return { text: '' };
  });
  on('prompt.fill', async (_$, e, _next) => {
    boom('prompt.fill');
    r.fills.push({ text: e.text, mode: e.mode });
    return { isFilled: true };
  });
  on('prompt.submit', async (_$, e, _next) => {
    r.submitted.push({ text: e.text, context: e.context });
    return { text: e.text, context: e.context };
  });
  on('prompt.compose', async (_$, _e, _next) => ({
    sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }, { id: 'memory', text: 'memory', scope: 'session' as const }],
  }));
  on('config.set', async (_$, e, _next) => {
    r.configs.push({ key: e.key, value: e.value });
    return { value: e.value };
  });
  on('turn.abort', async (_$, e, _next) => {
    r.aborts.push(e.turnId);
    return { value: undefined };
  });
  on('turn.start', async (_$, e, _next) => ({ turnId: e.turnId }));
  on('turn.complete', async (_$, _e, _next) => ({ text: '' }));
  on('session.compact', async (_$, _e, _next) => (o.compactSkip ? { skip: 'vetoed' } : { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }) as never);
  on('settings.read', async (_$, _e, _next) => ({ value: {} }));
  on('ui.open', async (_$, e, _next) => {
    r.panes.push(e.id);
    return { value: o.narrowPane ? { isPlaced: false as const, reason: 'narrow' as never } : { isPlaced: true as const } };
  });
  // The engine resolves a relative path against the working directory before any hook sees it: the rig keeps
  // what is under `.agento/` by its project-relative name, and any other file by its path.
  const rel = (p: string): string => (p.indexOf('.agento/') >= 0 ? p.slice(p.indexOf('.agento/')) : p);
  on('fs.exists', async (_$, e, _next) => ({ value: r.files.has(rel(e.path)) }));
  on('fs.write', async (_$, e, _next) => {
    boom('fs.write');
    r.files.set(rel(e.path), e.text);
    return { value: undefined };
  });
  on('fs.read', async (_$, e, _next) => ({ value: r.files.get(rel(e.path)) ?? '' }));
  // The engine's own drawing, where agento has nothing to draw.
  on('ui.render', async (_$, _e, _next) => ({ type: 'Text', props: {}, children: ['engine'] }) as never);
  on('session.start', async (_$, e, _next) => ({ cwd: e.cwd }));
  on('session.end', async (_$, e, _next) => ({ sessionId: e.sessionId }));
  on('turn.step', async function* (_$, e, _next) {
    boom('turn.step');
    r.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId });
    const usage: TurnUsage = {
      model: r.usage.model ?? e.model,
      input_tokens: r.usage.in,
      output_tokens: r.usage.out,
      cache_read_input_tokens: r.usage.read,
      cache_creation_input_tokens: r.usage.write,
    };
    const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage };
    yield { kind: 'stop', stopReason: 'end_turn', usage };
    return result;
  });
  on('agent.spawn', async (_$, e, _next) => {
    r.spawns.push(e as unknown as Record<string, unknown>);
    if (o.throwOn?.includes('agent.spawn:haiku') && e.model === 'haiku') throw new Error('boom: haiku refused');
    return { model: e.model ?? 'inherit', agentId: `ag${r.spawns.length}` };
  });
  on('tool.call', async (_$, e, _next) => {
    r.tools.push(e as unknown as Record<string, unknown>);
    const custom = r.results[String(e.tool)];
    if (custom !== undefined && !r.toolIsError) return { result: custom, text: 'ok' } as never;
    return (r.toolIsError ? { result: 'failed', text: 'failed', isError: true } : { result: 'ok', text: 'ok' }) as never;
  });
  return r;
}

// Runs one model request through the chain and returns what it resolved to.
export async function step($: Engine, input: Partial<TurnStepInput> = {}): Promise<TurnStepResult> {
  const g = $.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 3, ...input });
  for (;;) {
    const it = await g.next();
    if (it.done) return it.value;
  }
}

// A prompt as the person's Enter raises it; resolves to what the engine below received.
export const prompt = ($: Engine, text: string, origin: { kind: string } = { kind: 'composer' }) => $.prompt.submit({ text, wait: false, origin } as never);

// A slash command as the person types it: `/agento mode eco`.
export const slash = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never);

// A turn running to its end, as the engine raises its events.
export async function turn($: Engine, id: string, steps: () => Promise<unknown>): Promise<void> {
  await $.turn.start({ text: 'go', turnId: id } as never);
  await steps();
  await $.turn.complete({ turnId: id, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' } as never);
}
