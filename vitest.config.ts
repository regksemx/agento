import { defineConfig } from 'vitest/config';

// Unit tests only. Mod tests (plugin/tests/*.test.ts) run through `claude plugin test plugin`.
export default defineConfig({
  test: {
    include: ['plugin/core/**/*.spec.ts', 'plugin/features/**/*.spec.ts', 'cli/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
