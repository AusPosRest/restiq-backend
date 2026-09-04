import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    // Holds an exclusive advisory lock on TEST_DATABASE_URL for the whole
    // run, so a second concurrent e2e run against the same database fails
    // fast instead of racing this one's wipes/creates (see the file itself).
    globalSetup: ['test/global-setup-e2e.ts'],
    setupFiles: ['test/setup-e2e.ts'],
    // The suites share one test database (wipes, cross-tenant fixtures) -
    // parallel files would tread on each other's rows.
    fileParallelism: false,
    // argon2 hashing + app boot are deliberate work, not hangs
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  plugins: [swc.vite()],
})
