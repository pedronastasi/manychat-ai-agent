import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

/**
 * specs/050-langchain-runner-parity.md § Verification item 4, the lint rule
 * Constitution C2 says enforces it (§ The registry builds each chat model by
 * its class).
 */

const PROVIDER_PACKAGES = [
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@langchain/anthropic',
  '@langchain/openai',
  '@langchain/google-genai',
  'langchain/chat_models/universal',
];

const eslint = new ESLint();

async function errorsFor(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(message => message.ruleId === 'no-restricted-imports');
}

describe('only the registry imports a provider package (specs/050 V4, C2)', () => {
  it('configures the rule, for every provider package of both libraries and the universal chat model', async () => {
    const config = (await eslint.calculateConfigForFile('src/agent/runner.ts')) as {
      rules: Record<string, unknown>;
    };
    const [severity, options] = config.rules['no-restricted-imports'] as [
      number,
      { paths: { name: string }[] },
    ];
    expect(severity).toBe(2);
    expect(options.paths.map(path => path.name)).toEqual(PROVIDER_PACKAGES);
  });

  it.each(PROVIDER_PACKAGES)(
    'fails lint on %s imported outside the registry',
    async (name: string) => {
      const errors = await errorsFor(
        `import * as provider from '${name}';\nvoid provider;\n`,
        'src/agent/runner.ts',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('C2');
    },
  );

  it('lets the registry import them', async () => {
    const errors = await errorsFor(
      `import * as provider from '@langchain/anthropic';\nvoid provider;\n`,
      'src/agent/registry.ts',
    );
    expect(errors).toEqual([]);
  });
});
