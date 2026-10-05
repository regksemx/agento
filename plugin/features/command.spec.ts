import { describe, expect, it } from 'vitest';
import { nextMode, parseAgentoArgs, parseAutopilot, parseOnOff } from './command.ts';

describe('/agento arguments', () => {
  it('no arguments: the panel', () => {
    expect(parseAgentoArgs('')).toEqual({ kind: 'open' });
    expect(parseAgentoArgs('   ')).toEqual({ kind: 'open' });
  });
  it('mode', () => {
    for (const m of ['balanced', 'eco', 'quality', 'off']) expect(parseAgentoArgs(`mode ${m}`)).toEqual({ kind: 'mode', value: m });
    expect(parseAgentoArgs('MODE Eco')).toEqual({ kind: 'mode', value: 'eco' });
  });
  it('autopilot', () => {
    expect(parseAgentoArgs('autopilot clean-points')).toEqual({ kind: 'autopilot', value: 'clean-points' });
    expect(parseAgentoArgs('autopilot off')).toEqual({ kind: 'autopilot', value: 'off' });
  });
  it('orchestrate', () => {
    expect(parseAgentoArgs('orchestrate on')).toEqual({ kind: 'orchestrate', value: 'on' });
    expect(parseAgentoArgs('orchestrate off')).toEqual({ kind: 'orchestrate', value: 'off' });
  });
  it('new', () => {
    expect(parseAgentoArgs('new')).toEqual({ kind: 'new' });
  });
  it('anything else is a usage message, never a guess', () => {
    for (const bad of ['mode', 'mode turbo', 'autopilot full', 'orchestrate maybe', 'new now', 'frobnicate', 'mode eco extra']) {
      const c = parseAgentoArgs(bad);
      expect(c.kind).toBe('invalid');
      expect((c as { usage: string }).usage).toContain('/agento mode');
    }
  });
  it('option parsing falls back to the safe value', () => {
    expect(parseAutopilot('full')).toBe('clean-points');
    expect(parseAutopilot('off')).toBe('off');
    expect(parseAutopilot(undefined)).toBe('clean-points');
    expect(parseAutopilot('clean-points')).toBe('clean-points');
    expect(parseOnOff('on')).toBe('on');
    expect(parseOnOff('yes')).toBe('off');
  });
  it('the pane\'s mode button cycles', () => {
    expect(nextMode('balanced')).toBe('eco');
    expect(nextMode('eco')).toBe('quality');
    expect(nextMode('quality')).toBe('off');
    expect(nextMode('off')).toBe('balanced');
  });
});
