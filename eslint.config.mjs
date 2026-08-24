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
  // Module boundaries (AD-2): cross-module imports go through the target
  // module's index.ts barrel, never into its internals. Later blocks override
  // the general one so a module may still deep-import inside itself.
  {
    files: ['src/**', 'test/**', 'scripts/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ops/*', '!**/ops/index'],
              message: 'Import the ops module through its barrel (src/ops)',
            },
            {
              group: ['**/platform/*', '!**/platform/index'],
              message: 'Import the platform module through its barrel (src/platform)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ops/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/platform/*', '!**/platform/index'],
              message: 'Import the platform module through its barrel (src/platform)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/platform/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ops/*', '!**/ops/index'],
              message: 'Import the ops module through its barrel (src/ops)',
            },
          ],
        },
      ],
    },
  },
)
