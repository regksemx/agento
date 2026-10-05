// `/agento` arguments (spec §7.7): the pane, and the subcommands that change a setting. Pure.

import { MODES, type Mode } from '../core/spawn-policy.ts';

export type Autopilot = 'off' | 'clean-points';
export const AUTOPILOTS: readonly Autopilot[] = ['off', 'clean-points'];

export type AgentoCommand =
  | { kind: 'open' }
  | { kind: 'new' }
  | { kind: 'mode'; value: Mode }
  | { kind: 'autopilot'; value: Autopilot }
  | { kind: 'orchestrate'; value: 'on' | 'off' }
  | { kind: 'invalid'; usage: string };

// On unless switched off.
export function parseAutopilot(v: unknown): Autopilot {
  return v === 'off' ? 'off' : 'clean-points';
}

export function parseOnOff(v: unknown): 'on' | 'off' {
  return v === 'on' ? 'on' : 'off';
}

export const USAGE = [
  '/agento                              — panel',
  '/agento mode <balanced|eco|quality|off>',
  '/agento autopilot <off|clean-points>',
  '/agento orchestrate <on|off>         — takes effect from the next session',
  '/agento new                          — treat the next prompt as a new task',
].join('\n');

export function parseAgentoArgs(args: string): AgentoCommand {
  const [sub, value, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (sub === undefined) return { kind: 'open' };
  const s = sub.toLowerCase();
  const v = value?.toLowerCase();
  if (rest.length > 0) return { kind: 'invalid', usage: USAGE };
  if (s === 'new' && v === undefined) return { kind: 'new' };
  if (s === 'mode' && v !== undefined && (MODES as readonly string[]).includes(v)) return { kind: 'mode', value: v as Mode };
  if (s === 'autopilot' && v !== undefined && (AUTOPILOTS as readonly string[]).includes(v)) return { kind: 'autopilot', value: v as Autopilot };
  if (s === 'orchestrate' && (v === 'on' || v === 'off')) return { kind: 'orchestrate', value: v };
  return { kind: 'invalid', usage: USAGE };
}

// The next mode when the pane's mode button is pressed: balanced → eco → quality → off → balanced.
export function nextMode(m: Mode): Mode {
  return MODES[(MODES.indexOf(m) + 1) % MODES.length] ?? 'balanced';
}
