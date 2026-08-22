import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // src/generated is Prisma's output, rewritten by `npm run db:generate`;
  // linting it would only report on code we never touch.
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs', 'src/generated/**'] },
  js.configs.recommended,
  // Type-aware rules: this is the point of having eslint here at all. The one
  // that earns its keep is no-floating-promises - an un-awaited promise in an
  // order or payment path swallows its own error silently.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.check.json sees src AND prisma.config.ts; tsconfig.json
        // covers only what gets built, so type-aware linting needs the wider one.
        project: ['./tsconfig.check.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
