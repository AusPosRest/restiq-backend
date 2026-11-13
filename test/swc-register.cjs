// Lets a plain `node -r ./test/swc-register.cjs file.ts` child process load the
// backend's TypeScript with Nest's decorator metadata (as vitest's swc plugin
// does) - tsx/esbuild cannot emit it. Used by src/hub/recovery.spec.ts.
const { readFileSync } = require('node:fs')
const { transformSync } = require('@swc/core')

require.extensions['.ts'] = (module, filename) => {
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    filename,
    jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, target: 'es2022' },
    module: { type: 'commonjs' },
    sourceMaps: 'inline',
  })
  module._compile(code, filename)
}
