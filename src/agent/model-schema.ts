import { z } from 'zod';

/**
 * A JSON Schema as the model is shown it. Our own type, so nothing outside
 * the registry names a model library's (specs/053 § What moves, and to what).
 */
export type ModelJsonSchema = Record<string, unknown>;

/**
 * A Zod schema as the model sees it, byte for byte what the AI SDK's
 * `asSchema` produced: draft-7, the input side, reused schemas inlined, and
 * every object closed with `additionalProperties: false` (specs/053 § Tools are
 * LangChain tools, and the model sees the same bytes). The fixtures under
 * test/fixtures/model-library were recorded from `asSchema` itself.
 */
export function modelJsonSchema(schema: z.ZodType | undefined): ModelJsonSchema {
  if (schema === undefined) return { type: 'object', properties: {}, additionalProperties: false };
  return closeObjects(z.toJSONSchema(schema, { target: 'draft-7', io: 'input', reused: 'inline' }));
}

function closeObjects(node: Record<string, unknown>): Record<string, unknown> {
  const type = node.type;
  if (type === 'object' || (Array.isArray(type) && type.includes('object'))) {
    const { additionalProperties } = node;
    node.additionalProperties =
      additionalProperties != null && typeof additionalProperties !== 'boolean'
        ? visit(additionalProperties)
        : false;
    const properties = node.properties as Record<string, unknown> | undefined;
    if (properties != null) {
      for (const key of Object.keys(properties)) properties[key] = visit(properties[key]);
    }
  }
  if (node.items != null) {
    node.items = Array.isArray(node.items) ? node.items.map(visit) : visit(node.items);
  }
  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    const list = node[key];
    if (Array.isArray(list)) node[key] = list.map(visit);
  }
  const definitions = node.definitions as Record<string, unknown> | undefined;
  if (definitions != null) {
    for (const key of Object.keys(definitions)) definitions[key] = visit(definitions[key]);
  }
  return node;
}

function visit(node: unknown): unknown {
  if (typeof node === 'boolean' || node === null || typeof node !== 'object') return node;
  return closeObjects(node as Record<string, unknown>);
}

/** An error as the AI SDK printed a cause: its `toString`, or JSON. */
function errorMessage(error: unknown): string {
  if (error == null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.toString();
  return JSON.stringify(error);
}

/**
 * What the model is told when it calls a tool the turn did not offer: the
 * AI SDK's `NoSuchToolError` text, kept byte for byte, its `AI_` prefix
 * included, because the model reads it (specs/053 § Tools are LangChain tools,
 * and the model sees the same bytes).
 */
export function unknownToolText(toolName: string, availableTools: readonly string[]): string {
  return (
    `AI_NoSuchToolError: Model tried to call unavailable tool '${toolName}'. ` +
    `Available tools: ${availableTools.join(', ')}.`
  );
}

/**
 * What the model is told when a tool's input fails its schema: the AI SDK's
 * `InvalidToolInputError` wrapping a `TypeValidationError`, byte for byte.
 */
export function invalidToolInputText(toolName: string, input: unknown, cause: unknown): string {
  const validation =
    `AI_TypeValidationError: Type validation failed: Value: ${JSON.stringify(input)}.\n` +
    `Error message: ${errorMessage(cause)}`;
  return `AI_InvalidToolInputError: Invalid input for tool ${toolName}: ${validation}`;
}
