// The ladder for one task: configurations cheapest first, N samples each, stop at the first configuration where every sample
// passes. Pure logic around an injected `execute`, so budget stops, resume and sample aggregation are testable without claude.

import { applicableChecks } from './exec.ts';
import { FALLBACK_CONFIG, REPLAY_SCHEMA_VERSION, type L2Evidence, type LabelRecord, type LadderStep, type ReplayConfig, type RunRecord } from './types.ts';
import { runKey } from './store.ts';

// The money and run guard shared by every task of a replay run.
export class Budget {
  spent = 0;
  runs = 0;
  constructor(
    readonly totalUsd: number,
    private runsLeft = Infinity,
  ) {}
  get remaining(): number {
    return Math.max(0, this.totalUsd - this.spent);
  }
  // 'ok' when a run estimated at `estUsd` may start.
  check(estUsd: number): 'ok' | 'budget' | 'daily-cap' {
    if (estUsd > this.remaining) return 'budget';
    if (this.runsLeft <= 0) return 'daily-cap';
    return 'ok';
  }
  record(usd: number): void {
    this.spent += usd;
    this.runs += 1;
    this.runsLeft -= 1;
  }
}

export type LadderOutcome =
  | { kind: 'labeled'; label: LabelRecord; runs: RunRecord[] }
  | { kind: 'stopped'; reason: 'budget' | 'daily-cap'; runs: RunRecord[]; steps: LadderStep[] }
  | { kind: 'inconclusive'; reason: string; runs: RunRecord[]; steps: LadderStep[] }; // an infrastructure error, no verdict

export interface LadderInput {
  taskId: string;
  ladder: readonly ReplayConfig[];
  samples: number;
  budget: Budget;
  estimate: (cfg: ReplayConfig) => number; // USD for one run, safety factor included
  execute: (cfg: ReplayConfig, sample: number, maxBudgetUsd: number) => Promise<RunRecord>;
  onRun?: (r: RunRecord) => void; // persist immediately
  prior?: ReadonlyMap<string, RunRecord>; // finished runs of an earlier invocation
  evidence: { testCommand?: string; testBaseline?: 'pass' | 'fail'; originalEdited: boolean; judge: boolean; commit: string };
  priorCostUsd?: number;
  now?: () => number;
}

const cost = (r: RunRecord): number => r.costUsd + (r.judgeCostUsd ?? 0);

export async function runLadder(i: LadderInput): Promise<LadderOutcome> {
  const now = i.now ?? Date.now;
  const runs: RunRecord[] = [];
  const steps: LadderStep[] = [];
  let spentHere = i.priorCostUsd ?? 0;

  for (const cfg of i.ladder) {
    const recs: RunRecord[] = [];
    let reusedAll = true;
    for (let s = 1; s <= i.samples; s++) {
      let rec = i.prior?.get(runKey(i.taskId, cfg.id, s));
      if (!rec) {
        reusedAll = false;
        const est = i.estimate(cfg);
        const gate = i.budget.check(est);
        if (gate !== 'ok') return { kind: 'stopped', reason: gate, runs, steps };
        // the hard cap handed to claude: never more than what is left, and not wildly above the estimate
        const cap = Math.min(i.budget.remaining, Math.max(est * 2, 0.5));
        rec = await i.execute(cfg, s, cap);
        i.budget.record(cost(rec));
        spentHere += cost(rec);
        runs.push(rec);
        i.onRun?.(rec);
        if (rec.status === 'error') {
          steps.push({ config: cfg.id, samples: recs.length + 1, passed: recs.filter((r) => r.pass).length, pass: false });
          return { kind: 'inconclusive', reason: rec.error ?? 'run failed without a result', runs, steps };
        }
      }
      recs.push(rec);
      if (!rec.pass) break; // a configuration passes only if every sample does
    }
    const passed = recs.filter((r) => r.pass).length;
    const pass = recs.length === i.samples && passed === i.samples;
    steps.push({ config: cfg.id, samples: recs.length, passed, pass, ...(reusedAll ? { reused: true } : {}) });
    if (pass) return { kind: 'labeled', label: makeLabel(i, cfg, steps, spentHere, now()), runs };
  }
  return { kind: 'labeled', label: makeLabel(i, undefined, steps, spentHere, now()), runs };
}

function makeLabel(i: LadderInput, winner: ReplayConfig | undefined, steps: LadderStep[], costUsd: number, ts: number): LabelRecord {
  const cfg = winner ?? FALLBACK_CONFIG;
  const evidence: L2Evidence = {
    passedConfig: winner ? winner.id : null,
    steps,
    ...(i.evidence.testCommand ? { testCommand: i.evidence.testCommand } : {}),
    ...(i.evidence.testBaseline ? { testBaseline: i.evidence.testBaseline } : {}),
    checks: applicableChecks(i.evidence),
    commit: i.evidence.commit,
    samples: i.samples,
  };
  return { v: REPLAY_SCHEMA_VERSION, taskId: i.taskId, ts, l2Tier: cfg.tier, l2Effort: cfg.effort, l2Evidence: evidence, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}
