import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@core': resolve(__dirname, 'src/core') }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    exclude: ['tests/unit/live-*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/index.ts', 'src/core/**/*.d.ts'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 }
    }
  }
});
