import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { HumanMessage } from '@langchain/core/messages';

/**
 * specs/007-local-model.md § Verification: the parts CI can enforce. A local
 * model prices at zero, a model tag with its own colon resolves, the request
 * reaches `OLLAMA_BASE_URL` with that tag intact, and the compose service is
 * behind its profile and reports ready only once the model is pulled. Running
 * a real model is manual: CI cannot pull multi-gigabyte weights.
 */

/** A stand-in for Ollama's OpenAI-compatible API: it records the request and refuses it. */
let server: Server;
const seen: { path: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body });
      // A 400 is not retried, so the call fails at once.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invented refusal', type: 'invalid_request' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // Read when the registry module loads, so set before it is imported.
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  delete process.env.OLLAMA_BASE_URL;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const registry = () => import('../../src/agent/registry.ts');

describe('a local model is free, so the cost cap never fires on it (specs/007 V5)', () => {
  it('prices any ollama: model at exactly zero', async () => {
    const { estimateCostUsd } = await registry();
    for (const spec of ['ollama:llama3.1:8b', 'ollama:gemma3:4b', 'ollama:an-unlisted-model']) {
      expect(
        estimateCostUsd(spec, { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 500 }),
      ).toBe(0);
    }
  });

  it('still prices an unknown hosted model pessimistically', async () => {
    const { estimateCostUsd } = await registry();
    expect(
      estimateCostUsd('openai:an-unlisted-model', { inputTokens: 2000, outputTokens: 200 }),
    ).toBeGreaterThan(0);
  });
});

describe('a model tag with its own colon resolves and reaches Ollama intact (specs/007 V6)', () => {
  it('resolves through both the AI SDK registry and the LangChain registry', async () => {
    const { resolveModel, resolveChatModel } = await registry();
    expect(typeof resolveModel('ollama:llama3.1:8b')).toBe('object');
    const handle = resolveChatModel('ollama:llama3.1:8b', {
      maxOutputTokens: 50,
      temperature: 0.2,
    });
    expect(handle.model).toBeDefined();
  });

  it('sends the chat request to OLLAMA_BASE_URL, with the full tag and a placeholder key', async () => {
    const { resolveChatModel } = await registry();
    const { model } = resolveChatModel('ollama:llama3.1:8b', {
      maxOutputTokens: 50,
      temperature: 0.2,
    });
    await expect(model.invoke([new HumanMessage('hello')])).rejects.toThrow();
    const request = seen.at(-1)!;
    expect(request.path).toBe('/v1/responses');
    expect(request.headers.authorization).toBe('Bearer ollama');
    expect((JSON.parse(request.body) as { model: string }).model).toBe('llama3.1:8b');
  });

  it('assumes a local model has no vision, so images take the fallback (specs/020)', async () => {
    const { acceptsImages } = await registry();
    expect(acceptsImages('ollama:llama3.1:8b')).toBe(false);
  });
});

describe('the compose service starts only on request, and is ready only with its model (specs/007 V1)', () => {
  const compose = parse(readFileSync('docker-compose.yml', 'utf8')) as {
    services: Record<
      string,
      {
        profiles?: string[];
        healthcheck?: { test: string[] };
        volumes?: string[];
        entrypoint?: string[];
        environment?: Record<string, string>;
      }
    >;
  };
  const { ollama, 'ollama-pull': pull, agent } = compose.services;

  it('keeps ollama and its pull behind the local-model profile, so a plain up pulls nothing', () => {
    expect(ollama?.profiles).toEqual(['local-model']);
    expect(pull?.profiles).toEqual(['local-model']);
    expect(agent?.profiles).toBeUndefined();
  });

  it('caches the weights in a named volume, and points the agent at the service', () => {
    expect(ollama?.volumes).toEqual(['ollama:/root/.ollama']);
    expect(agent?.environment?.OLLAMA_BASE_URL).toBe('http://ollama:11434/v1');
  });

  it('reports healthy only when the pinned model is there, and pulls that same model', () => {
    const health = ollama?.healthcheck?.test.join(' ') ?? '';
    expect(health).toContain('ollama show ${LOCAL_MODEL:-llama3.1:8b}');
    expect(pull?.entrypoint?.join(' ')).toContain('ollama pull ${LOCAL_MODEL:-llama3.1:8b}');
    expect(pull?.environment?.OLLAMA_HOST).toBe('http://ollama:11434');
  });
});
