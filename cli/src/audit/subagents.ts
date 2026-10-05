import { ZERO_COST, addCost, repriceAs, type CostBreakdown } from '../../../plugin/core/cost.ts';
import { familyOf, tierOf, tierRank, type ModelFamily } from '../../../plugin/core/pricing.ts';
import type { ApiCall, Corpus, SessionData, SubagentSection, ToolUse } from '../types.ts';
import { callCost } from './spend.ts';

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'pwd', 'echo', 'which', 'stat', 'file', 'tree', 'du', 'df', 'sort', 'uniq', 'cut',
  'jq', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cd', 'test', 'true', 'type', 'printenv', 'env', 'sed', 'column', 'nl',
]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set(['status', 'log', 'diff', 'show', 'branch', 'ls-files', 'rev-parse', 'blame', 'describe', 'remote', 'grep', 'ls-tree', 'shortlog']);

// A Bash command that only looks around: every pipeline segment starts with a read-only program, no redirects to files.
export function isReadOnlyBash(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/\$\(|`|<\(/.test(command)) return false;
  const noFdRedirects = command.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '');
  if (/>/.test(noFdRedirects)) return false;
  for (const segment of noFdRedirects.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
    const prog = words[0];
    if (!prog) continue;
    if (prog === 'git') {
      if (!READ_ONLY_GIT.has(words[1] ?? '')) return false;
    } else if (!READ_ONLY_COMMANDS.has(prog)) return false;
    if (prog === 'find' && words.some((w) => w === '-delete' || w === '-exec' || w === '-execdir' || w === '-ok')) return false;
    if (prog === 'sed' && words.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) return false;
  }
  return true;
}

export function isReadOnlyToolUse(t: ToolUse): boolean {
  if (READ_ONLY_TOOLS.has(t.name)) return true;
  if (t.name === 'Bash') {
    const input = t.input as { command?: unknown } | null;
    return isReadOnlyBash(input?.command);
  }
  return false;
}

const EXPLORE = 'Explore';
const GENERAL = 'general-purpose';
const UNKNOWN_TYPE = 'unknown';

export function analyzeSubagents(c: Corpus): SubagentSection {
  let totalAll = 0;
  let calls = 0;
  let cost = 0;
  const families = new Map<ModelFamily, number>();
  const types = new Map<string, { calls: number; cost: number }>();
  const lineages = new Map<string, { type: string; calls: ApiCall[] }>();
  const bySession = new Map<string, SessionData>();
  const byAgent = new Map<string, string>(); // fallback when a call was merged into another session
  for (const s of c.sessions) {
    bySession.set(s.sessionId, s);
    for (const [id, a] of Object.entries(s.agents ?? {})) if (!byAgent.has(id)) byAgent.set(id, a.type);
  }

  for (const s of c.sessions) {
    for (const call of s.calls) {
      const price = callCost(call)?.total ?? 0;
      totalAll += price;
      if (call.lineage === 'main') continue;
      calls++;
      cost += price;
      const family = familyOf(call.model);
      families.set(family, (families.get(family) ?? 0) + price);

      const id = call.lineage.slice('agent:'.length);
      const type = bySession.get(call.sessionId)?.agents?.[id]?.type ?? byAgent.get(id) ?? UNKNOWN_TYPE;
      const t = types.get(type) ?? { calls: 0, cost: 0 };
      types.set(type, { calls: t.calls + 1, cost: t.cost + price });

      const key = `${call.sessionId}/${call.lineage}`;
      const l = lineages.get(key);
      if (l) l.calls.push(call);
      else lineages.set(key, { type, calls: [call] });
    }
  }

  const haiku = { count: 0, cost: 0, asHaiku: 0 };
  const sonnet = { count: 0, cost: 0, asSonnet: 0 };
  for (const { type, calls: list } of lineages.values()) {
    const h = haikuCandidate(type, list);
    if (h) {
      haiku.count++;
      haiku.cost += h.cost;
      haiku.asHaiku += h.asHaiku;
      continue;
    }
    const sn = sonnetCandidate(type, list);
    if (sn) {
      sonnet.count++;
      sonnet.cost += sn.cost;
      sonnet.asSonnet += sn.asSonnet;
    }
  }

  return {
    share: totalAll > 0 ? cost / totalAll : 0,
    calls,
    cost,
    byFamily: [...families].map(([family, v]) => ({ family, cost: v })).sort((a, b) => b.cost - a.cost),
    byType: [...types].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.cost - a.cost || a.type.localeCompare(b.type)),
    haikuCandidates: haiku,
    sonnetCandidates: sonnet,
  };
}

// An Explore subagent, or one whose every tool use only reads or searches, that ran above haiku: haiku would likely have done.
function haikuCandidate(type: string, list: ApiCall[]): { cost: number; asHaiku: number } | null {
  const above = tierRank('sonnet');
  let toolUses = 0;
  let readOnly = true;
  let cost: CostBreakdown = ZERO_COST;
  let hk: CostBreakdown = ZERO_COST;
  for (const call of list) {
    const tier = tierOf(call.model);
    if (!tier || tierRank(tier) < above) return null;
    const price = callCost(call);
    const cheap = repriceAs('haiku', call.usage);
    if (!price || !cheap) return null;
    for (const t of call.toolUses) {
      toolUses++;
      if (!isReadOnlyToolUse(t)) readOnly = false;
    }
    cost = addCost(cost, price);
    hk = addCost(hk, cheap);
  }
  if (type !== EXPLORE && !(readOnly && toolUses > 0)) return null;
  return { cost: cost.total, asHaiku: hk.total };
}

// A general-purpose subagent (the one that builds things) on opus/fable: an upper bound for what sonnet could save.
function sonnetCandidate(type: string, list: ApiCall[]): { cost: number; asSonnet: number } | null {
  if (type !== GENERAL) return null;
  const expensive = tierRank('opus');
  let cost: CostBreakdown = ZERO_COST;
  let sn: CostBreakdown = ZERO_COST;
  for (const call of list) {
    const tier = tierOf(call.model);
    if (!tier || tierRank(tier) < expensive) return null;
    const price = callCost(call);
    const cheap = repriceAs('sonnet', call.usage);
    if (!price || !cheap) return null;
    cost = addCost(cost, price);
    sn = addCost(sn, cheap);
  }
  return list.length > 0 ? { cost: cost.total, asSonnet: sn.total } : null;
}
