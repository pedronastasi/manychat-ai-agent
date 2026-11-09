import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AgentReplyForModel } from '../../src/contracts/agent.ts';
import {
  invalidToolInputText,
  modelJsonSchema,
  unknownToolText,
} from '../../src/agent/model-schema.ts';
import { fullToolSet, INVALID_SET_FIELD_INPUT } from '../helpers/model-library.ts';

/**
 * specs/053-one-model-library.md § Verification. The fixtures were recorded
 * from the AI SDK's `asSchema` and error classes before they were replaced
 * (commit "test: record today's tool and reply schemas…"); a difference here
 * is a finding, not a fixture to re-record.
 */

const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(`test/fixtures/model-library/${name}.json`, 'utf8'));

/** Byte for byte: same keys, same order, same values. */
const bytes = (value: unknown) => JSON.stringify(value);

describe('the model sees the same tool and reply schema bytes (specs/053 V3)', () => {
  it('derives every tool’s name, description and JSON schema as the AI SDK did', () => {
    const definitions = Object.entries(fullToolSet()).map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: modelJsonSchema(tool.schema),
    }));
    expect(bytes(definitions)).toBe(bytes(recorded('tool-definitions')));
  });

  it('derives the reply schema as the AI SDK did', () => {
    expect(bytes(modelJsonSchema(AgentReplyForModel))).toBe(bytes(recorded('reply-schema')));
  });

  it('gives a tool with no input schema an empty closed object, as asSchema did', () => {
    expect(modelJsonSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('a tool error answers the model with today’s text (specs/053 V4)', () => {
  const errors = recorded('tool-errors') as { unknown: string; invalid: string };

  it('names an unknown tool and the tools offered, as NoSuchToolError did', () => {
    expect(unknownToolText('not_offered', Object.keys(fullToolSet()))).toBe(errors.unknown);
  });

  it('quotes the input and the schema’s complaint, as InvalidToolInputError did', async () => {
    const schema = fullToolSet().set_field!.schema;
    const checked = await schema.safeParseAsync(INVALID_SET_FIELD_INPUT);
    expect(checked.success).toBe(false);
    expect(invalidToolInputText('set_field', INVALID_SET_FIELD_INPUT, checked.error)).toBe(
      errors.invalid,
    );
  });
});
