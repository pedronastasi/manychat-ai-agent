import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import swagger from '@fastify/swagger';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { ManyChatInbound, ManyChatResponse } from './contracts/manychat.ts';
import { capabilitiesFor } from './contracts/config.ts';
import type { Env } from './contracts/config.ts';
import type { Database } from './db/client.ts';
import { resolveModel } from './agent/registry.ts';
import { GenerateTextRunner } from './agent/runner.ts';
import type { AgentRunner } from './agent/runner.ts';
import { ManyChatAdapter } from './channels/manychat/adapter.ts';
import { ManyChatHttpClient } from './channels/manychat/client.ts';
import type { ConfigStore } from './config/loader.ts';
import { TurnHandler } from './routes/turn.ts';
import { createSharedSecretGuard } from './routes/auth.ts';
import { REDACT_PATHS, pseudonymize } from './observability/redact.ts';

export interface BuildOptions {
  env: Env;
  db: Database;
  configStore: ConfigStore;
  /** Injected by tests to avoid a live provider. */
  runner?: AgentRunner;
}

export function buildServer(opts: BuildOptions) {
  const { env, db, configStore } = opts;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Redaction lives here so no call site can forget it (Constitution C5).
      redact: { paths: REDACT_PATHS, remove: true },
    },
    // ManyChat payloads are small; a large body is a red flag, not a use case.
    bodyLimit: 64 * 1024,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const tenant = () => configStore.get();
  const capabilities = capabilitiesFor(env.CHANNEL);

  const manychatClient = env.MANYCHAT_API_TOKEN
    ? new ManyChatHttpClient({
        apiToken: env.MANYCHAT_API_TOKEN,
        baseUrl: env.MANYCHAT_API_BASE,
        replyField: env.MANYCHAT_REPLY_FIELD,
        replyFlowNs: env.MANYCHAT_REPLY_FLOW_NS ?? '',
      })
    : {
        // Without a token the deferred path cannot deliver. Fail loudly at use
        // rather than silently dropping a customer's reply.
        sendText: () =>
          Promise.reject(
            new Error('MANYCHAT_API_TOKEN is not set; cannot deliver deferred replies'),
          ),
      };

  const adapter = new ManyChatAdapter(manychatClient);

  const runner =
    opts.runner ??
    new GenerateTextRunner({
      model: resolveModel(env.AGENT_MODEL),
      modelSpec: env.AGENT_MODEL,
      // The accessor, not its result: the runner re-reads it so SIGHUP reaches
      // the persona and catalog, not just the rules turn.ts reads per request.
      config: tenant,
      maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
      temperature: env.AGENT_TEMPERATURE,
      reasoningEffort: env.AGENT_REASONING_EFFORT,
    });

  const registerPlugins = async () => {
    await app.register(helmet, { contentSecurityPolicy: false });
    await app.register(underPressure, { maxEventLoopDelay: 1000, exposeStatusRoute: false });
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      // Per subscriber when identifiable, else per IP, so one noisy contact
      // cannot consume another's budget.
      keyGenerator: req => {
        const body = req.body as { subscriber_id?: string | number } | undefined;
        return body?.subscriber_id ? `sub:${String(body.subscriber_id)}` : `ip:${req.ip}`;
      },
    });
    await app.register(swagger, {
      openapi: {
        info: { title: 'ManyChat AI Agent', version: '0.1.0' },
        components: {
          securitySchemes: {
            sharedSecret: { type: 'http', scheme: 'bearer' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
  };

  app.get('/health', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  app.get('/ready', { logLevel: 'warn' }, async (_req, reply) => {
    try {
      await db.execute('select 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post(
    '/v1/channels/manychat/message',
    {
      preHandler: createSharedSecretGuard(env.MANYCHAT_SHARED_SECRET),
      schema: {
        summary: 'ManyChat Dynamic Block webhook',
        body: ManyChatInbound,
        response: { 200: ManyChatResponse },
        security: [{ sharedSecret: [] }],
      },
    },
    async request => {
      const inbound = adapter.parse(request.body, {
        tenantId: env.TENANT_ID,
        channel: env.CHANNEL,
      });

      const log = request.log.child({
        // Correlates a conversation without storing the identifier (C5).
        contact: pseudonymize(inbound.subscriberId, env.TENANT_ID),
      });

      // Constructed per request: `tenant()` re-reads config, which SIGHUP can
      // have reloaded since the last turn.
      const handler = new TurnHandler({
        db,
        runner,
        rules: tenant().rules,
        raceDeadlineMs: env.RACE_DEADLINE_MS,
        modelAbortMs: env.MODEL_ABORT_MS,
        logger: log,
      });
      const { reply, outcome } = await handler.handle(inbound);

      log.info({ outcome, escalated: reply.escalate }, 'turn complete');

      return adapter.render(reply, {
        capabilities,
        // Re-registered every turn so the loop stays server-side (specs/002).
        callbackUrl: `${env.PUBLIC_BASE_URL}/v1/channels/manychat/message`,
        callbackSecret: env.MANYCHAT_SHARED_SECRET[0],
      });
    },
  );

  return { app, registerPlugins, runner };
}
