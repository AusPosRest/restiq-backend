import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// swc, not esbuild: Nest's DI needs emitDecoratorMetadata, which esbuild
// cannot emit.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
  plugins: [swc.vite()],
})
