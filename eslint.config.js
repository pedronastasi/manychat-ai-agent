import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Constitution C2: only the registry imports a model provider's package. The
 * universal chat model is listed too, because `initChatModel` loads a provider
 * with a dynamic `import()` that this rule could not otherwise see
 * (specs/050 § The registry builds each chat model by its class).
 */
export const PROVIDER_PACKAGES = [
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@langchain/anthropic',
  '@langchain/openai',
  '@langchain/google-genai',
  'langchain/chat_models/universal',
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'packages/create/agent/**',
      'db/migrations/**',
      '.vitepress/cache/**',
      '.vitepress/dist/**',
      '.claude/worktrees/**',
    ],
  },

  js.configs.recommended,

  // Type-aware linting covers the TypeScript program only. This config file is
  // not part of it, so the typed rules must not be applied globally.
  {
    files: ['**/*.ts'],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Secrets and PII must never reach stdout directly; use the redacting logger.
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // ADR-0009: the name is the documentation, at the point of use. No
      // exception list, deliberately - that is where this kind of rule dies.
      'id-length': ['error', { min: 2 }],
    },
  },

  {
    files: ['**/*.ts'],
    ignores: ['src/agent/registry.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: PROVIDER_PACKAGES.map(name => ({
            name,
            message: 'Only src/agent/registry.ts imports a provider package (Constitution C2).',
          })),
        },
      ],
    },
  },

  {
    // Plain Node scripts: declare the globals they legitimately use.
    files: ['scripts/**/*.mjs', 'packages/create/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },

  {
    // Operational entrypoints and dev tooling legitimately write to stdout.
    files: [
      'evals/**/*.ts',
      'scripts/**/*.ts',
      'src/channels/manychat/simulator.ts',
      'src/backfill.ts',
      'src/insights.ts',
      'src/learning/commands.ts',
      'src/cli.ts',
      'src/cli/**/*.ts',
      'src/evals/**/*.ts',
      '*.config.ts',
    ],
    rules: { 'no-console': 'off' },
  },

  {
    // Test APIs are untyped by nature: `response.json()` is `any`, and mock
    // implementations satisfy async interfaces without awaiting anything.
    // Enforcing these here produces casts that obscure what a test asserts.
    files: ['test/**/*.ts', 'src/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
