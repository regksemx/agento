// Backend 2: `claude -p` as a subprocess. Spends the user's subscription limit (or API credit), so the command layer
// requires --max-tasks and a confirmation. The system prompt goes through --system-prompt, the task on stdin.

import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { BackendError, type JudgeBackend, type JudgeCompletion, type JudgePrompt } from './types.ts';

export type SpawnFn = typeof nodeSpawn;

export interface ClaudeOptions {
  model: string; // haiku | sonnet | opus (or a full model id)
  timeoutMs: number;
  bin?: string;
  spawnFn?: SpawnFn;
}

// Tools off, no session file, no skills, a fixed small system prompt: the call is a pure text classification.
export function claudeArgs(model: string, system: string): string[] {
  return ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--disable-slash-commands', '--tools', '', '--system-prompt', system];
}

interface ClaudeJson {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

export function parseClaudeOutput(stdout: string): JudgeCompletion {
  let j: ClaudeJson;
  try {
    j = JSON.parse(stdout) as ClaudeJson;
  } catch {
    throw new BackendError('claude: output is not JSON', false);
  }
  if (j.is_error) throw new BackendError(`claude: ${typeof j.result === 'string' ? j.result.slice(0, 200) : 'error result'}`, false);
  if (typeof j.result !== 'string') throw new BackendError('claude: no result field', false);
  const u = j.usage;
  const input = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : undefined;
  return {
    text: j.result,
    usage: { inputTokens: input, outputTokens: u?.output_tokens, costUsd: j.total_cost_usd },
    resolvedModel: j.modelUsage ? Object.keys(j.modelUsage)[0] : undefined,
  };
}

export function claudeBackend(o: ClaudeOptions): JudgeBackend {
  const spawnFn = o.spawnFn ?? nodeSpawn;
  const bin = o.bin ?? 'claude';
  return {
    kind: 'claude',
    model: o.model,
    complete(p: JudgePrompt): Promise<JudgeCompletion> {
      return new Promise((resolve, reject) => {
        // cwd outside any project: no CLAUDE.md or project settings leak into the judge call
        const child = spawnFn(bin, claudeArgs(o.model, p.system), { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let done = false;
        const finish = (fn: () => void): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(() => {
          finish(() => reject(new BackendError(`claude: timeout after ${o.timeoutMs} ms`, false)));
          child.kill('SIGKILL');
        }, o.timeoutMs);
        child.stdout?.on('data', (d: Buffer | string) => (out += d.toString()));
        child.stderr?.on('data', (d: Buffer | string) => (err += d.toString()));
        child.on('error', (e: Error) => finish(() => reject(new BackendError(`claude: ${e.message}`, false))));
        child.on('close', (code: number | null) =>
          finish(() => {
            if (code !== 0) return reject(new BackendError(`claude exited with code ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}`, false));
            try {
              resolve(parseClaudeOutput(out));
            } catch (e) {
              reject(e);
            }
          }),
        );
        child.stdin?.on('error', () => undefined);
        child.stdin?.write(p.user);
        child.stdin?.end();
      });
    },
  };
}
