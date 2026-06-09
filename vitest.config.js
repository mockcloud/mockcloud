import { defineConfig } from 'vitest/config';

// MockCloud's tests spin up the AWS dispatch layer on an ephemeral port and
// share the in-memory `store` singleton + a pid-keyed disk root (see
// tests/helpers/{server,test-env}.js). The `forks` pool runs each test file in
// its own process, so module state is isolated and the per-process disk roots
// never collide across parallel workers.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    pool: 'forks',
    globals: false,        // tests import { describe, it, ... } from 'vitest'
    testTimeout: 30000,    // Lambda tests spawn `node` child processes — be generous
    hookTimeout: 30000,
  },
});
