import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
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
