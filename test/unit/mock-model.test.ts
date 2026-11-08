import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type { AIMessage } from '@langchain/core/messages';
import { createMockModel } from '../../src/agent/mock-provider.ts';
import { resolveChatModel } from '../../src/agent/registry.ts';

/**
 * specs/053-one-model-library.md § Verification, The mock: `mock:` is a
 * LangChain.js chat model (§ The mock and every fake are LangChain chat
 * models). That it answers as the AI SDK mock did, case for case, is CI's four
 * `eval:mock` runs, compared before and after in the pull request that
 * rewrote it; these pin what the runs do not show.
 */

describe('mock: is a LangChain chat model (specs/053 V10)', () => {
  it('resolves to a BaseChatModel, not an AI SDK model wrapped in AiSdkChatModel', () => {
    const { model } = resolveChatModel('mock:demo', { maxOutputTokens: 400, temperature: 0 });
    expect(model).toBeInstanceOf(BaseChatModel);
    expect(model._llmType()).toBe('mock');
  });

  it('imports neither ai nor @ai-sdk', () => {
    const source = readFileSync('src/agent/mock-provider.ts', 'utf8');
    expect(source).not.toMatch(/from '(ai|@ai-sdk\/[^']+)'/);
  });

  it('reports the usage it always reported, so the budget cap still counts its turns', async () => {
    const answer = (await createMockModel('demo').model.invoke([
      new HumanMessage('hello'),
    ])) as AIMessage;
    expect(answer.usage_metadata).toEqual({
      input_tokens: 1200,
      output_tokens: 60,
      total_tokens: 1260,
      input_token_details: { cache_read: 1000 },
    });
  });

  it('answers mock:judge with a passing verdict', async () => {
    const answer = (await createMockModel('judge').model.invoke([
      new HumanMessage('grade this'),
    ])) as AIMessage;
    expect(JSON.parse(String(answer.content))).toMatchObject({ verdict: 'pass' });
  });

  it('stops mock:slow on the abort, as the race needs (C7)', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = createMockModel('slow').model.invoke([new HumanMessage('hello')], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
