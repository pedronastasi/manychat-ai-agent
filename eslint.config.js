import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Constitution C2: only the registry imports a model provider's package. The
 * universal chat model is listed too, because `initChatModel` loads a provider
 * with a dynamic `import()` that this rule could not otherwise see
 * (specs/050 § The registry builds each chat model by its class).
 */
export const PROVIDER_PACKAGES = [
  '@langchain/anthropic',
  '@langchain/openai',
  '@langchain/google-genai',
  'langchain/chat_models/universal',
  // The transcription client (specs/053 § C2's import list names the transcription client).
  'openai',
];

/**
 * The Vercel AI SDK left the service (specs/053, ADR-0030), so it is refused
 * everywhere, the registry included: a stray import fails lint before it
 * fails install.
 */
const REMOVED_MESSAGE =
  'The AI SDK left this service: use LangChain.js, or a port in the registry (specs/053).';
export const REMOVED_PACKAGES = ['ai', 'ai/test'];
const removed = {
  paths: REMOVED_PACKAGES.map(name => ({ name, message: REMOVED_MESSAGE })),
  patterns: [{ group: ['@ai-sdk/*'], message: REMOVED_MESSAGE }],
};

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
          paths: [
            ...PROVIDER_PACKAGES.map(name => ({
              name,
              message: 'Only src/agent/registry.ts imports a provider package (Constitution C2).',
            })),
            ...removed.paths,
          ],
          patterns: removed.patterns,
        },
      ],
    },
  },

  {
    files: ['src/agent/registry.ts'],
    rules: { 'no-restricted-imports': ['error', removed] },
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
