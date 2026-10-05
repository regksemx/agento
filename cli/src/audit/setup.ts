import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { costOf, prefixTokens } from '../../../plugin/core/cost.ts';
import { priceOf } from '../../../plugin/core/pricing.ts';
import type { Corpus, SetupSection } from '../types.ts';
import { mainCalls } from './cache-misses.ts';
import { coveredDays } from './spend.ts';

export interface SetupOptions {
  readFile?: (path: string) => string | null;
  days?: number; // period the corpus covers; defaults to the span of its requests
}

export const BYTES_PER_TOKEN = 3.6;
export const TRIM_TARGET_BYTES = 20 * 1024;
const MONTH_DAYS = 30;

const TOP_CLAUDE_MD = 10;

function readFromDisk(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function analyzeSetup(c: Corpus, opts: SetupOptions = {}): SetupSection {
  const readFile = opts.readFile ?? readFromDisk;
  let sessions = 0;
  let tokens = 0;
  let cost = 0;
  for (const s of c.sessions) {
    const first = mainCalls(s)[0];
    if (!first) continue;
    sessions += 1;
    tokens += prefixTokens(first.usage);
    cost += costOf(first.model, first.usage)?.cacheWrite ?? 0;
  }

  // Cache-read price of everything the main thread read in sessions started in each directory, in $ per token held in the prefix.
  const readPrice = new Map<string, number>();
  for (const s of c.sessions) {
    if (!s.cwd) continue;
    let sum = readPrice.get(s.cwd) ?? 0;
    for (const call of mainCalls(s)) sum += (priceOf(call.model)?.cacheRead ?? 0) / 1_000_000;
    readPrice.set(s.cwd, sum);
  }
  const perMonth = MONTH_DAYS / Math.max(1, opts.days ?? coveredDays(c));

  const paths = new Map<string, string>(); // file -> cwd it was found for
  for (const s of c.sessions) {
    if (!s.cwd) continue;
    paths.set(join(s.cwd, 'CLAUDE.md'), s.cwd);
    paths.set(join(s.cwd, '.claude', 'CLAUDE.md'), s.cwd);
  }
  const claudeMd: SetupSection['claudeMd'] = [];
  for (const [path, cwd] of paths) {
    let text: string | null = null;
    try {
      text = readFile(path);
    } catch {
      text = null;
    }
    if (text === null) continue;
    const bytes = Buffer.byteLength(text, 'utf8');
    const tokens = bytes / BYTES_PER_TOKEN;
    const price = readPrice.get(cwd) ?? 0;
    const excess = Math.max(0, bytes - TRIM_TARGET_BYTES) / BYTES_PER_TOKEN;
    claudeMd.push({ path, bytes, tokens, monthlyReadCost: tokens * price * perMonth, trimSaving: excess * price * perMonth });
  }
  claudeMd.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  return { avgFixedPrefixTokens: sessions > 0 ? tokens / sessions : 0, fixedPrefixCost: cost, claudeMd: claudeMd.slice(0, TOP_CLAUDE_MD) };
}
