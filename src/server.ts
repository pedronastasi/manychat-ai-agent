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
import { capabilitiesFor, NO_TOOLS } from './contracts/config.ts';
import type { Env } from './contracts/config.ts';
import type { AgentReply, InboundMessage } from './contracts/agent.ts';
import type { TranscriptionModel } from 'ai';
import type { Database } from './db/client.ts';
import { acceptsImages, resolveModel, resolveTranscriptionModel } from './agent/registry.ts';
import { GenerateTextRunner } from './agent/runner.ts';
import type { AgentRunner } from './agent/runner.ts';
import { SdkTranscriber } from './agent/transcriber.ts';
import { ManyChatAdapter } from './channels/manychat/adapter.ts';
import { manychatClientFor } from './channels/manychat/client.ts';
import type { ActionPerformer, ContactReader, ManyChatClient } from './channels/manychat/client.ts';
import { channelAdapters } from './channels/plugin/adapter.ts';
import type { ContactTokenWriter } from './conversation/tokens.ts';
import { ManyChatMediaFetcher } from './channels/manychat/media.ts';
import type { ConfigStore } from './config/loader.ts';
import { detectFfmpeg, FfmpegVideoSplitter, type FfmpegPaths } from './media/ffmpeg.ts';
import { MediaResolver } from './media/resolver.ts';
import { TurnHandler, type TurnDeps, type TurnLogger } from './routes/turn.ts';
import { TurnLanes } from './conversation/turns.ts';
import { bearerToken, createSharedSecretGuard, isAuthenticated } from './routes/auth.ts';
import { escalationReply } from './agent/guardrails.ts';
import { mediaScrubbingStream, redactText } from './observability/redact.ts';
import { loggerOptions } from './observability/logger.ts';
import type { PlaybookSource } from './learning/playbook.ts';
import { Plugins } from './plugins/plugins.ts';

const MESSAGE_ROUTE = '/v1/channels/manychat/message';

/**
 * A plugin channel's turns issue no token, so nothing is ever written
 * (specs/038). Refusing, should that change unnoticed.
 */
const NO_TOKEN_WRITER: ContactTokenWriter = {
  writeToken: () => Promise.reject(new Error('a plugin channel writes no contact token')),
};

/**
 * What a plugin channel's turn performs a built-in action through. None is
 * offered there, so none is staged; one that were would fail, never reach
 * ManyChat for a contact who is not on it (specs/038, C6).
 */
const MANYCHAT_UNAVAILABLE: ActionPerformer = {
  performAction: () => Promise.reject(new Error('a plugin channel performs no ManyChat action')),
};

export interface BuildOptions {
  env: Env;
  db: Database;
  configStore: ConfigStore;
  /** Injected by tests to avoid a live provider. */
  runner?: AgentRunner;
  /** Injected by tests to read what the service logs. */
  logStream?: { write(line: string): void };
  /**
   * The process's one ManyChat client, shared with the outbox worker so the
   * configured rate is the real one (specs/022). Built from `env` when absent.
   */
  manychat?: ManyChatClient;
  /**
   * Reads the turn's contact for `get_contact` (specs/024): the same client
   * as `manychat` in production. Without it, and without `manychat` to build
   * one from `env`, the agent is offered no contact read.
   */
  contacts?: ContactReader;
  /** Injected by tests: the ManyChat HTTP boundary, API and media host alike. */
  manychatFetch?: typeof fetch;
  /** Injected by tests in place of resolving TRANSCRIPTION_MODEL: the model boundary. */
  transcriptionModel?: TranscriptionModel;
  /** Injected by tests to stand in for a server without ffmpeg. */
  ffmpegPaths?: FfmpegPaths;
  /** The tenant's plugins, loaded once at boot (specs/036). None when absent. */
  plugins?: Plugins;
  /** The active playbook version (specs/031). None without a `learning` block. */
  playbook?: PlaybookSource | undefined;
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
      // Redaction lives here so no call site can forget it (Constitution C5).
      ...loggerOptions(env.LOG_LEVEL),
      // And media URLs leave every line, whichever field carried them (specs/020).
      stream: mediaScrubbingStream(opts.logStream ?? process.stdout),
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

  const built = opts.manychat ? undefined : manychatClientFor(env, opts.manychatFetch);
  const manychatClient = opts.manychat ?? built!;
  const contacts = opts.contacts ?? built;

  const adapter = new ManyChatAdapter(manychatClient);
  const plugins = opts.plugins ?? Plugins.NONE;

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
      plugins,
      playbook: opts.playbook,
    });

  // Resolved once, like the answering model: a TRANSCRIPTION_MODEL typo fails
  // the deploy, and a missing ffmpeg is found at boot rather than per video.
  const transcriber = env.TRANSCRIPTION_MODEL
    ? new SdkTranscriber({
        model: opts.transcriptionModel ?? resolveTranscriptionModel(env.TRANSCRIPTION_MODEL),
        modelSpec: env.TRANSCRIPTION_MODEL,
      })
    : null;
  const ffmpeg = await detectFfmpeg(opts.ffmpegPaths);
  const media = new MediaResolver({
    fetcher: new ManyChatMediaFetcher(opts.manychatFetch),
    transcriber,
    splitter: ffmpeg ? new FfmpegVideoSplitter(opts.ffmpegPaths) : null,
    acceptsImages: acceptsImages(env.AGENT_MODEL),
  });
  // Each missing piece is a deliberate state, not an error: the media it
  // would read asks the contact to type instead (specs/020).
  app.log.info(
    {
      transcription: env.TRANSCRIPTION_MODEL ?? null,
      images: acceptsImages(env.AGENT_MODEL),
      ffmpeg,
    },
    'media capabilities',
  );

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
    // ManyChat fills the contact's token in, so a callback binds like an entry.
    contactTokenField: env.MANYCHAT_TOKEN_FIELD,
    // And their offering, read per request so a reload reaches it (specs/028).
    offeringField: tenant().tools?.fields.find(field => field.offering)?.field,
  });

  // The plugins' channels, each mounted beside ManyChat's route (specs/038).
  const channels = channelAdapters(plugins, app.log);

  /** How each message route renders a handoff, by route. */
  const handoffs = new Map<string, (reply: AgentReply, secret: string | undefined) => unknown>([
    [
      MESSAGE_ROUTE,
      (handoff, secret) => adapter.render(handoff, { capabilities, ...callbackFor(secret) }),
    ],
    ...[...channels.values()].map(
      channel => [channel.route, (handoff: AgentReply) => channel.render(handoff)] as const,
    ),
  ]);

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

    // On a message route a failure, overload included, is a handoff to a
    // person, never a 500 carrying the error or a 503 the contact never sees
    // (C6, specs/017 § An error on the message route is a handoff, not a 500).
    // A plugin channel's route hands off the same way, through its own
    // renderer (specs/038).
    const route = request.routeOptions.url;
    const render = route === undefined ? undefined : handoffs.get(route);
    if (render && isAuthenticated(request, env.MANYCHAT_SHARED_SECRET)) {
      try {
        const handoff = render(
          escalationReply('low_confidence', tenant().rules.messages.escalation),
          bearerToken(request.headers.authorization),
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

  /** Each inline turn's staged actions, until its response has been sent. */
  const afterResponse = new WeakMap<object, () => Promise<void>>();
  // One for the process, so every request for a contact shares the order
  // (specs/037). Past this bound everything a turn runs has ended (C6).
  const lanes = new TurnLanes(env.MODEL_ABORT_MS + env.RACE_DEADLINE_MS);

  // After the response is sent, never before: the text the actions follow
  // has to leave first (specs/012 § Actions follow the text).
  const performAfterResponse = async (request: object) => {
    const perform = afterResponse.get(request);
    afterResponse.delete(request);
    if (perform) await perform();
  };

  /** One turn, on any message route; what differs between channels is `deps`. */
  const runTurn = async (
    request: { log: TurnLogger },
    inbound: InboundMessage,
    deps: Pick<
      TurnDeps,
      'tokenWriter' | 'tokensEnforced' | 'actions' | 'contacts' | 'tools' | 'channel'
    >,
  ) => {
    // Constructed per request: `tenant()` re-reads config, which SIGHUP can
    // have reloaded since the last turn.
    const handler = new TurnHandler({
      db,
      runner,
      rules: tenant().rules,
      raceDeadlineMs: env.RACE_DEADLINE_MS,
      modelAbortMs: env.MODEL_ABORT_MS,
      logger: request.log,
      plugins,
      media,
      lanes,
      ...deps,
    });
    const turn = await handler.handle(inbound);
    const { reply, outcome, conversationId, binding } = turn;
    if (turn.afterResponse) afterResponse.set(request, turn.afterResponse);

    // The conversation's random ID, never anything derived from the
    // subscriber ID (ADR-0014). `binding` gives the share of unbound turns
    // that shows a flow has stopped sending the token (specs/019).
    request.log.info(
      {
        conversation: conversationId,
        outcome,
        binding,
        escalated: reply.escalate,
        ...(deps.channel ? { channel: deps.channel } : {}),
        ...(turn.silent ? { silent: true } : {}),
      },
      'turn complete',
    );
    return turn;
  };

  app.post(
    MESSAGE_ROUTE,
    {
      onRequest: createSharedSecretGuard(env.MANYCHAT_SHARED_SECRET),
      onResponse: performAfterResponse,
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
        logger: request.log,
      });
      const turn = await runTurn(request, inbound, {
        tokenWriter: manychatClient,
        tokensEnforced: env.CONTACT_TOKENS_ENFORCED,
        // A plugin action goes to its plugin, the rest to ManyChat (specs/036).
        actions: plugins.performer(manychatClient, request.log),
        contacts,
        tools: tenant().tools,
      });
      return adapter.render(turn.reply, {
        capabilities,
        silent: turn.silent,
        // Re-registered every turn so the loop stays server-side (specs/002).
        ...callbackFor(bearerToken(request.headers.authorization)),
      });
    },
  );

  // Each plugin channel runs exactly as ManyChat's route does: the same auth,
  // rate limit, budget, race, order and outbox. What it is not given is
  // ManyChat: no contact token, no `tools.json` tool, no contact read
  // (specs/038).
  for (const channel of channels.values()) {
    app.post(
      channel.route,
      {
        onRequest: createSharedSecretGuard(env.MANYCHAT_SHARED_SECRET),
        // Its own schema, before anything reads the body (C3). Its detail is
        // not returned: the plugin's schema is the plugin's.
        preValidation: async (request, reply) => {
          if (!channel.accepts(request.body)) {
            await reply.code(400).send({ error: 'invalid request' });
          }
        },
        onResponse: performAfterResponse,
        schema: {
          summary: `Plugin channel ${channel.name} (provisional, specs/038)`,
          security: [{ sharedSecret: [] }],
        },
      },
      async request => {
        const inbound = channel.parse(request.body, {
          tenantId: env.TENANT_ID,
          channel: channel.name,
        });
        const turn = await runTurn(request, inbound, {
          tokenWriter: NO_TOKEN_WRITER,
          tokensEnforced: false,
          actions: plugins.performer(MANYCHAT_UNAVAILABLE, request.log),
          contacts: undefined,
          tools: NO_TOOLS,
          channel: channel.name,
        });
        // A silent response carries no message: the reply follows from the
        // outbox (specs/030, specs/037).
        return channel.render(turn.silent ? { ...turn.reply, messages: [] } : turn.reply);
      },
    );
  }

  return { app, runner };
}
