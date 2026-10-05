// Robust parsing of a judge answer: strip reasoning blocks and code fences, find the first JSON object, validate it.

import { JUDGE_CONFIGS, type ConfigId, type JudgeProbs, type JudgeVerdict } from './types.ts';

export type ParseResult = { ok: true; verdict: JudgeVerdict } | { ok: false; error: string };

const MAX_RATIONALE = 400;

// All balanced `{...}` candidates in order of appearance (string- and escape-aware). Cheap: bounded by text length.
function* objectCandidates(text: string): Generator<string> {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        yield text.slice(start, i + 1);
        break;
      }
    }
  }
}

// Reasoning models may emit <think>…</think> before the answer; fences are the usual chatter.
function clean(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json|JSON)?/g, '')
    .trim();
}

const normKey = (k: string): string => k.toLowerCase().replace(/[\s·_.:/\\]+/g, '-');

function readProbs(raw: unknown): JudgeProbs | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'probs: expected an object';
  const byKey = new Map(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [normKey(k), v]));
  const out = {} as JudgeProbs;
  for (const c of JUDGE_CONFIGS) {
    const v = byKey.get(c.id);
    if (typeof v !== 'number' || !Number.isFinite(v)) return `probs.${c.id}: expected a number`;
    if (v < 0 || v > 1) return `probs.${c.id}: ${v} is outside 0..1`;
    out[c.id as ConfigId] = v;
  }
  return out;
}

function validate(o: unknown): ParseResult {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { ok: false, error: 'not a JSON object' };
  const r = o as Record<string, unknown>;
  const probs = readProbs(r.probs);
  if (typeof probs === 'string') return { ok: false, error: probs };
  if (typeof r.needsPlanFirst !== 'boolean') return { ok: false, error: 'needsPlanFirst: expected a boolean' };
  if (typeof r.delegateExplore !== 'boolean') return { ok: false, error: 'delegateExplore: expected a boolean' };
  const d = r.difficulty;
  if (typeof d !== 'number' || !Number.isFinite(d) || d < 1 || d > 5) return { ok: false, error: 'difficulty: expected a number from 1 to 5' };
  const rationale = typeof r.rationale === 'string' ? r.rationale.trim().slice(0, MAX_RATIONALE) : '';
  return { ok: true, verdict: { probs, needsPlanFirst: r.needsPlanFirst, delegateExplore: r.delegateExplore, difficulty: Math.round(d), rationale } };
}

export function parseJudgeResponse(text: string): ParseResult {
  const body = clean(text);
  if (body === '') return { ok: false, error: 'empty response' };
  let firstError = 'no JSON object found';
  let seen = false;
  for (const cand of objectCandidates(body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand);
    } catch {
      if (!seen) firstError = 'invalid JSON';
      seen = true;
      continue;
    }
    const v = validate(parsed);
    if (v.ok) return v;
    if (!seen) firstError = v.error;
    seen = true;
  }
  return { ok: false, error: firstError };
}
