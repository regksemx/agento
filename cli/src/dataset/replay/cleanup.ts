// Cleanup registry: worktrees and child processes must go away on normal exit, Ctrl-C, SIGTERM and crashes.

export class Cleanup {
  private fns = new Map<number, () => void>();
  private next = 1;
  private uninstallFn: (() => void) | undefined;

  // Registers a cleanup function; returns a disposer that runs it once (and forgets it).
  add(fn: () => void): () => void {
    const id = this.next++;
    this.fns.set(id, fn);
    return () => {
      const f = this.fns.get(id);
      if (!f) return;
      this.fns.delete(id);
      try {
        f();
      } catch {
        // cleanup must never throw
      }
    };
  }

  // Runs everything still registered (newest first). Safe to call repeatedly.
  runAll(): void {
    for (const id of [...this.fns.keys()].reverse()) {
      const f = this.fns.get(id);
      this.fns.delete(id);
      try {
        f?.();
      } catch {
        // keep going: the other worktrees still need removing
      }
    }
  }

  get size(): number {
    return this.fns.size;
  }

  // Process-level handlers. Returns the uninstaller.
  install(proc: NodeJS.Process = process): () => void {
    if (this.uninstallFn) return this.uninstallFn;
    const onExit = (): void => this.runAll();
    const signal = (name: NodeJS.Signals, code: number) => (): void => {
      this.runAll();
      proc.exit(code);
      void name;
    };
    const onInt = signal('SIGINT', 130);
    const onTerm = signal('SIGTERM', 143);
    const onHup = signal('SIGHUP', 129);
    const onCrash = (e: unknown): void => {
      this.runAll();
      process.stderr.write(`agento: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      proc.exit(1);
    };
    proc.on('exit', onExit);
    proc.on('SIGINT', onInt);
    proc.on('SIGTERM', onTerm);
    proc.on('SIGHUP', onHup);
    proc.on('uncaughtException', onCrash);
    proc.on('unhandledRejection', onCrash);
    this.uninstallFn = (): void => {
      proc.off('exit', onExit);
      proc.off('SIGINT', onInt);
      proc.off('SIGTERM', onTerm);
      proc.off('SIGHUP', onHup);
      proc.off('uncaughtException', onCrash);
      proc.off('unhandledRejection', onCrash);
      this.uninstallFn = undefined;
    };
    return this.uninstallFn;
  }
}
