import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests boot a PGlite instance per test. That is a few seconds
    // normally and noticeably slower under v8 coverage instrumentation, so the
    // default 5s timeout produces failures that are purely about tooling speed.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // specs/004-testing.md § Deliberately not unit tested. Each of these is
      // either test infrastructure, a developer CLI, declarative, or wiring
      // that needs a real process - a test would assert our own assumptions
      // rather than any behaviour.
      exclude: [
        'src/agent/mock-provider.ts',
        'src/channels/manychat/simulator.ts',
        'src/channels/port.ts',
        'src/db/client.ts',
        'src/db/schema.ts',
        'src/main.ts',
      ],
      reporter: ['text', 'json-summary'],
      // A floor that catches regressions, not a target. Ratchets up, never down.
      thresholds: { statements: 85, branches: 75, functions: 85, lines: 85 },
    },
  },
});
