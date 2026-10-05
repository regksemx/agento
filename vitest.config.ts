import { defineConfig } from 'vitest/config';

// Unit tests only. Mod tests (plugin/tests/*.test.ts) run through `claude plugin test plugin`.
export default defineConfig({
  // plugin/tsconfig.json extends the types Claude Code writes into plugin/.claude-plugin/types/ on a machine that has
  // loaded the mod; a fresh clone (CI) has none. The few options esbuild needs are given here instead.
  esbuild: {
    tsconfigRaw: JSON.stringify({ compilerOptions: { target: 'es2023', jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }),
  },
  test: {
    include: ['plugin/core/**/*.spec.ts', 'plugin/features/**/*.spec.ts', 'cli/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
