import { z } from 'zod';
import { ActionKind, ActionStatus, FlowOrigin } from './agent.ts';

/**
 * A scripted conversation run against the agent's production turn path
 * (specs/043). Every input is checked here before any model call (C3); what
 * a schema cannot check, such as a configured id, is checked against the
 * tenant by `validateSuite`.
 */

const Id = z.string().min(1);

const Turn = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
});

/**
 * An action as the scenario expects to find it on the trace. The status is
 * mandatory, so a staged write is never mistaken for a performed one
 * (specs/043 § Assertions cover steps, transitions, and terminal outcomes).
 * `attempted` matches a request that reached the channel, whether it was
 * performed or failed.
 */
export const ActionMatcher = z
  .object({
    tool: ActionKind,
    id: Id,
    value: z.string().optional(),
    status: z.union([ActionStatus, z.literal('attempted')]),
    origin: FlowOrigin.optional(),
  })
  .strict();
export type ActionMatcher = z.infer<typeof ActionMatcher>;

const ActionAssertions = z
  .object({
    required: z.array(ActionMatcher).optional(),
    forbidden: z.array(ActionMatcher).optional(),
    exact: z.array(ActionMatcher).optional(),
    order: z.array(ActionMatcher).min(2).optional(),
  })
  .strict();

/** A catalogue value a reply must or must not carry, rendered as the prompt renders it. */
export const ArtifactSelector = z
  .object({
    offering: Id,
    field: z.enum(['name', 'price', 'url', 'schedule']),
  })
  .strict();
export type ArtifactSelector = z.infer<typeof ArtifactSelector>;

/** The contact's state after the step settles. Fields are named by their `tools.json` id. */
export const StateAssertion = z
  .object({
    fields: z.record(z.string(), z.string().nullable()).optional(),
    tags: z
      .object({ present: z.array(Id).optional(), absent: z.array(Id).optional() })
      .strict()
      .optional(),
    offering: z.string().nullable().optional(),
  })
  .strict();
export type StateAssertion = z.infer<typeof StateAssertion>;

/** An entry of the delivery trace: a flow the contact saw, or a reply message. */
export const DeliveryMatcher = z.union([
  z.object({ flow: Id }).strict(),
  z.object({ reply: z.string() }).strict(),
]);
export type DeliveryMatcher = z.infer<typeof DeliveryMatcher>;

export const StepExpect = z
  .object({
    escalate: z.boolean().optional(),
    reason: z.string().optional(),
    must_contain: z.array(z.string()).optional(),
    must_not_contain: z.array(z.string()).optional(),
    must_not_invent_prices: z.boolean().optional(),
    must_end_with_question: z.boolean().optional(),
    max_lines: z.number().int().positive().optional(),
    state: StateAssertion.optional(),
    actions: ActionAssertions.optional(),
    delivery: z
      .object({ order: z.array(DeliveryMatcher).min(2) })
      .strict()
      .optional(),
    closing_question: z
      .union([z.enum(['required', 'absent']), z.object({ exact: z.string() }).strict()])
      .optional(),
  })
  .strict();
export type StepExpect = z.infer<typeof StepExpect>;

/**
 * What the contact does at a step. `message` is ordinary contact input;
 * `opening` is the channel flow's opening-trigger keyword, a trusted event.
 * Media and silence steps are specified and not run yet.
 */
export const StepInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('message'),
      text: z.string(),
      /** The offering of the advert the contact arrived through (specs/034). */
      advert_offering: Id.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('opening'), text: z.string().min(1) }).strict(),
]);
export type StepInput = z.infer<typeof StepInput>;

export const Step = z
  .object({
    id: Id,
    input: StepInput,
    expect: StepExpect.default({}),
    review: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Step = z.infer<typeof Step>;

/** A step or an entry of the trace, for temporal assertions. */
export const TraceRef = z.union([
  z.object({ step: Id }).strict(),
  z.object({ flow: Id }).strict(),
  z.object({ action: ActionMatcher }).strict(),
  z.object({ artifact: ArtifactSelector }).strict(),
]);
export type TraceRef = z.infer<typeof TraceRef>;

export const TERMINALS = ['completed', 'handoff', 'declined', 'error'] as const;
export type Terminal = (typeof TERMINALS)[number];

export const ConversationExpect = z
  .object({
    terminal: z.enum(TERMINALS),
    /** The step the handoff must happen at, and its reason. */
    handoff: z.object({ step: Id, reason: z.string().optional() }).strict().optional(),
    state: StateAssertion.optional(),
    actions: ActionAssertions.extend({
      counts: z
        .array(z.object({ match: ActionMatcher, count: z.number().int().nonnegative() }).strict())
        .optional(),
    })
      .strict()
      .optional(),
    artifacts: z
      .object({
        required: z.array(ArtifactSelector).optional(),
        forbidden: z.array(ArtifactSelector).optional(),
      })
      .strict()
      .optional(),
    /** `first` occurs, then `then` occurs after it. */
    order: z.array(z.object({ first: TraceRef, then: TraceRef }).strict()).optional(),
    /** `ref` does not occur after `after`, such as no reminder after the link. */
    never_after: z.array(z.object({ ref: TraceRef, after: TraceRef }).strict()).optional(),
  })
  .strict();
export type ConversationExpect = z.infer<typeof ConversationExpect>;

/**
 * A returning contact's state before the first step. Seeded state never earns
 * coverage, and it must be consistent with itself.
 */
export const InitialState = z
  .object({
    history: z.array(Turn).default([]),
    /** Actions an earlier agent turn performed, as the record holds them. */
    actions: z.array(ActionMatcher.omit({ status: true, origin: true })).default([]),
    offering: Id.optional(),
  })
  .strict();
export type InitialState = z.infer<typeof InitialState>;

export const Scenario = z
  .object({
    id: Id,
    description: z.string().min(1),
    initial: InitialState.optional(),
    steps: z.array(Step).min(1),
    expect: ConversationExpect,
    review: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

/**
 * What a customer-visible flow shows, for whoever reads the transcript: its
 * authored content, or a summary labelled as one. A silent flow has none.
 * The harness never downloads the tenant's live flow content.
 */
export const FlowFixture = z.union([
  z.object({ content: z.string().min(1) }).strict(),
  z.object({ summary: z.string().min(1) }).strict(),
]);
export type FlowFixture = z.infer<typeof FlowFixture>;

export const ChannelFixtures = z
  .object({ flows: z.record(z.string(), FlowFixture).default({}) })
  .strict();
export type ChannelFixtures = z.infer<typeof ChannelFixtures>;
