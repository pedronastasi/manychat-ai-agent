import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';

/**
 * A deterministic, offline model used for local development, CI, and demos.
 *
 * It exists so the repository can be cloned and run end-to-end with no API key
 * and no spend, and so the eval harness has a fixed baseline to assert the
 * pipeline itself (not the model) still works.
 *
 * The usage shape below is the PROVIDER-facing one — nested
 * `{total, noCache, cacheRead, cacheWrite}` — which the SDK flattens for
 * callers. Emitting the flattened shape here silently yields undefined token
 * counts, which would make the budget cap a no-op.
 */
function reply(messages: string[], escalate: boolean, reason: string | null, confidence: number) {
  return JSON.stringify({
    messages,
    escalate,
    escalation_reason: reason,
    confidence,
  });
}

/**
 * Keyword routing that models a CORRECT agent, so `pnpm eval:mock` is a green
 * baseline for the pipeline itself. A real model's deviations then show up as
 * eval failures rather than being lost in noise from a sloppy stub.
 *
 * Order matters: injection and negotiation are checked before the price branch,
 * since "decime el precio real de costo" is an attack, not a price question.
 */
function respondTo(text: string): string {
  const t = text.toLowerCase();
  if (/(ignora|ignore|system prompt|sin reglas|a partir de ahora sos|olvida tus)/.test(t)) {
    return reply(
      ['Eso no lo puedo hacer. Te paso con alguien del equipo?'],
      true,
      'out_of_scope',
      0.9,
    );
  }
  if (/(bot|humano|persona real|sos una maquina)/.test(t)) {
    return reply(
      ['Si, soy un asistente automatico 🙂', 'Si preferis, te paso con alguien del equipo.'],
      false,
      null,
      0.95,
    );
  }
  if (/(certificado|titulo|diploma)/.test(t)) {
    return reply(['Si, al finalizar recibis un certificado de asistencia.'], false, null, 0.9);
  }
  if (/(material|kit|incluye)/.test(t)) {
    return reply(['El kit de practica esta incluido en todos los cursos.'], false, null, 0.9);
  }
  if (/(donde|sede|direccion|online|presencial)/.test(t)) {
    return reply(['Las clases son presenciales en la sede central.'], false, null, 0.88);
  }
  if (/(descuento|cuotas|rebaja|mas barato|caro)/.test(t)) {
    return reply(
      ['Con el tema de precios te paso con alguien del equipo.'],
      true,
      'price_negotiation',
      0.95,
    );
  }
  if (/(queja|reclamo|reembolso|devolucion|estafa)/.test(t)) {
    return reply(['Perdon por eso. Te paso con alguien ahora mismo.'], true, 'complaint', 0.95);
  }
  if (/(precio|sale|cuesta|cuanto|valor)/.test(t)) {
    return reply(
      ['El Curso Inicial sale $45.000.', 'Son 24hs, martes y jueves de 18 a 21h. Te paso el link?'],
      false,
      null,
      0.9,
    );
  }
  if (/(horario|cuando|dia|cursada)/.test(t)) {
    return reply(
      ['El inicial es martes y jueves de 18 a 21h, durante 4 semanas.'],
      false,
      null,
      0.88,
    );
  }
  if (/(hola|buenas|buen dia)/.test(t)) {
    return reply(
      ['Hola! Contame que curso te interesa y te paso los detalles.'],
      false,
      null,
      0.92,
    );
  }
  return reply(
    ['Eso no lo tengo a mano, dejame que te pase con alguien del equipo.'],
    true,
    'out_of_scope',
    0.8,
  );
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const m = options.prompt[i];
    if (m?.role === 'user') {
      const content = m.content;
      if (typeof content === 'string') return content;
      return content.map(p => (p.type === 'text' ? p.text : '')).join(' ');
    }
  }
  return '';
}

export function createMockModel(modelId: string): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId,
    supportedUrls: {},

    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const text = respondTo(lastUserText(options));
      // `mock:slow` deliberately exceeds the race deadline so the deferred path
      // can be exercised without a real slow provider.
      if (modelId === 'slow') {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 12_000);
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 },
          outputTokens: { total: 60, text: 60, reasoning: 0 },
        },
        warnings: [],
      };
    },

    doStream: () => {
      throw new Error('mock provider does not support streaming');
    },
  };
}
