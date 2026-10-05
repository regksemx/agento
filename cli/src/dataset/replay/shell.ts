// Runs a shell command (project test command, dependency install) in a directory with a timeout. Output is discarded:
// only the exit code matters, and test output may quote code the agent just wrote.

import { spawn as nodeSpawn } from 'node:child_process';
import type { Cleanup } from './cleanup.ts';

export interface ShellResult {
  code: number | null; // null: killed by the timeout or failed to start
  timedOut: boolean;
}

export type ShellFn = (command: string, o: { cwd: string; timeoutMs: number }) => Promise<ShellResult>;

export function makeShell(cleanup?: Cleanup, spawnFn: typeof nodeSpawn = nodeSpawn): ShellFn {
  return (command, o) =>
    new Promise((resolve) => {
      let done = false;
      let timedOut = false;
      const child = spawnFn('sh', ['-c', command], {
        cwd: o.cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      });
      const killGroup = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      };
      const dispose = cleanup?.add(killGroup);
      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        dispose?.();
        resolve({ code, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, o.timeoutMs);
      child.on('error', () => finish(null));
      child.on('close', (code: number | null) => finish(timedOut ? null : code));
    });
}
