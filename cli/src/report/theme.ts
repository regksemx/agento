// ANSI theme in the visual language of Claude Code: clay accent, warm greys, no dependencies.

import type { ModelFamily } from '../types.ts';

export type ColorMode = 'truecolor' | '256' | 'none';

export function detectColor(env: Record<string, string | undefined>, isTTY: boolean): ColorMode {
  if (env.NO_COLOR) return 'none';
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    if (force === '0' || force === 'false') return 'none';
    if (force === '3') return 'truecolor';
    if (force === '1' || force === '2') return '256';
  } else if (!isTTY) return 'none';
  if (env.TERM === 'dumb') return 'none';
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return '256';
  return '256';
}

type Rgb = [number, number, number, number];
type Style = (s: string) => string;

const RESET = '\x1b[0m';

const PALETTE = {
  accent: [217, 119, 87, 173],
  sand: [201, 162, 122, 180],
  sage: [127, 182, 133, 108],
  slate: [128, 153, 176, 109],
  violet: [167, 139, 202, 140],
  white: [240, 238, 230, 255],
  grey: [139, 134, 128, 245],
  red: [200, 90, 84, 167],
} satisfies Record<string, Rgb>;

export interface Theme {
  mode: ColorMode;
  accent: Style;
  accentBold: Style;
  sand: Style;
  dim: Style;
  num: Style;
  bold: Style;
  good: Style;
  bad: Style;
  family(f: ModelFamily): Style;
  // Stacked-bar segment i (0..3): style and glyph; glyphs differ in no-color mode.
  segment(i: number): { style: Style; glyph: string };
}

export function makeTheme(mode: ColorMode): Theme {
  const plain: Style = (s) => s;
  if (mode === 'none') {
    const glyphs = ['█', '▓', '▒', '░'];
    return {
      mode,
      accent: plain,
      accentBold: plain,
      sand: plain,
      dim: plain,
      num: plain,
      bold: plain,
      good: plain,
      bad: plain,
      family: () => plain,
      segment: (i) => ({ style: plain, glyph: glyphs[i % 4]! }),
    };
  }
  const paint =
    (c: Rgb, extra = ''): Style =>
    (s) =>
      s === '' ? s : `\x1b[${extra}${mode === 'truecolor' ? `38;2;${c[0]};${c[1]};${c[2]}` : `38;5;${c[3]}`}m${s}${RESET}`;
  const accent = paint(PALETTE.accent);
  const sand = paint(PALETTE.sand);
  const slate = paint(PALETTE.slate);
  const violet = paint(PALETTE.violet);
  const dim = paint(PALETTE.grey);
  const segs = [accent, sand, paint(PALETTE.white), dim];
  return {
    mode,
    accent,
    accentBold: paint(PALETTE.accent, '1;'),
    sand,
    dim,
    num: paint(PALETTE.white),
    bold: paint(PALETTE.white, '1;'),
    good: paint(PALETTE.sage),
    bad: paint(PALETTE.red),
    family: (f) => {
      if (f.startsWith('opus')) return accent;
      if (f.startsWith('sonnet')) return sand;
      if (f.startsWith('haiku')) return slate;
      if (f.startsWith('fable')) return violet;
      return dim;
    },
    segment: (i) => ({ style: segs[i % 4]!, glyph: '█' }),
  };
}
