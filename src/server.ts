import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
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
import { bearerToken, createSharedSecretGuard, isAuthenticated } from './routes/auth.ts';
import { escalationReply } from './agent/guardrails.ts';
import { REDACT_PATHS, redactText } from './observability/redact.ts';

const MESSAGE_ROUTE = '/v1/channels/manychat/message';

export interface BuildOptions {
  env: Env;
  db: Database;
  configStore: ConfigStore;
  /** Injected by tests to avoid a live provider. */
  runner?: AgentRunner;
  /** Injected by tests to read what the service logs. */
  logStream?: { write(line: string): void };
}

/**
 * The whole production composition. Plugins are registered before any route is
 * declared, inside this function, because `@fastify/rate-limit` and anything
 * else that hooks `onRoute` never sees a route declared before it. Doing both
 * here leaves no call for a caller to make in the wrong order (specs/017 § A
 * control that no test fires does not exist).
 */
export async function buildServer(opts: BuildOptions) {
  const { env, db, configStore } = opts;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Redaction lives here so no call site can forget it (Constitution C5).
      redact: { paths: REDACT_PATHS, remove: true },
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    // ManyChat payloads are small; a large body is a red flag, not a use case.
    bodyLimit: 64 * 1024,
    // Only the listed proxies are believed about the caller's address. `true`
    // believed any X-Forwarded-For, so rotating the header reset the rate limit
    // (specs/017 § Rate limiting is attached before any route).
    trustProxy: env.TRUST_PROXY.length > 0 ? env.TRUST_PROXY.join(',') : false,
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

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(underPressure, { maxEventLoopDelay: 1000, exposeStatusRoute: false });
  // Per address, as an app-level `onRequest` hook. That runs before each
  // route's own hooks, so a request that fails authentication still counts.
  // Requests with and without the shared secret get separate budgets, so a
  // flood that cannot authenticate never spends ManyChat's, even when every
  // caller shares one address behind an unlisted proxy. There is no
  // per-subscriber key: the body is not parsed yet at this point, and
  // BudgetGuard limits each contact in the database instead.
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: request =>
      `${isAuthenticated(request, env.MANYCHAT_SHARED_SECRET) ? 'secret' : 'anonymous'}:${request.ip}`,
  });
  app.addHook('onRequest', app.rateLimit());
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

  /** Where ManyChat sends the contact's next message (specs/002). */
  const callbackFor = (presentedSecret: string | undefined) => ({
    callbackUrl: `${env.PUBLIC_BASE_URL}${MESSAGE_ROUTE}`,
    // The secret this caller presented, not always the first: handing back
    // secrets[0] gave a caller holding a retired secret its replacement.
    callbackSecret: presentedSecret,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Client errors (rate limit, oversized body, validation) keep Fastify's
    // answer. Validation runs after authentication, so its detail reaches only
    // a caller holding the secret.
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);

    // Load shedding is deliberate, not a fault: under-pressure refuses new
    // work while the event loop lags, and passes its 503 through here.
    const shed = error.code === 'FST_UNDER_PRESSURE';
    if (shed) {
      request.log.warn({ route: request.routeOptions.url }, 'load shed');
    } else {
      // The message is redacted because a driver error can quote a query's
      // parameters, and those include the contact's text (C5).
      request.log.error(
        { error: { name: error.name, code: error.code, message: redactText(error.message) } },
        'unhandled error',
      );
    }

    // On the message route a failure, overload included, is a handoff to a
    // person, never a 500 carrying the error or a 503 the contact never sees
    // (C6, specs/017 § An error on the message route is a handoff, not a 500).
    if (
      request.routeOptions.url === MESSAGE_ROUTE &&
      isAuthenticated(request, env.MANYCHAT_SHARED_SECRET)
    ) {
      try {
        const handoff = adapter.render(
          escalationReply('low_confidence', tenant().rules.messages.escalation),
          { capabilities, ...callbackFor(bearerToken(request.headers.authorization)) },
        );
        // under-pressure sets it for its 503; on a 200 it means nothing.
        reply.removeHeader('retry-after');
        return reply.code(200).send(handoff);
      } catch (renderError) {
        // Without a valid handoff there is nothing to send but the plain answer
        // below; this line is how anyone learns contacts stopped reaching a
        // person.
        const failure = renderError instanceof Error ? renderError : new Error(String(renderError));
        request.log.error(
          { error: { name: failure.name, message: redactText(failure.message) } },
          'handoff failed',
        );
      }
    }
    return reply.code(error.statusCode ?? 500).send({ error: shed ? 'unavailable' : 'internal' });
  });

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
    MESSAGE_ROUTE,
    {
      onRequest: createSharedSecretGuard(env.MANYCHAT_SHARED_SECRET),
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

      // Constructed per request: `tenant()` re-reads config, which SIGHUP can
      // have reloaded since the last turn.
      const handler = new TurnHandler({
        db,
        runner,
        rules: tenant().rules,
        raceDeadlineMs: env.RACE_DEADLINE_MS,
        modelAbortMs: env.MODEL_ABORT_MS,
        logger: request.log,
      });
      const { reply, outcome, conversationId } = await handler.handle(inbound);

      // The conversation's random ID, never anything derived from the
      // subscriber ID (ADR-0014).
      request.log.info(
        { conversation: conversationId, outcome, escalated: reply.escalate },
        'turn complete',
      );

      return adapter.render(reply, {
        capabilities,
        // Re-registered every turn so the loop stays server-side (specs/002).
        ...callbackFor(bearerToken(request.headers.authorization)),
      });
    },
  );

  return { app, runner };
}
