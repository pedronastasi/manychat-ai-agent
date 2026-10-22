import { z } from 'zod';
import { FUNNEL_STAGES, INTENT_VALUES } from './funnel.ts';

/**
 * What the model names an entry by. Kept to plain identifiers because it
 * becomes an enum value in a tool's parameter schema, which every provider
 * renders into JSON Schema.
 */
const ToolEntryId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Expected lowercase letters, digits, "_" or "-"');

/** Guidance the model reads: what the entry is and when to use it. Tenant copy. */
const ToolDescription = z.string().min(1);

const uniqueIds = (entries: { id: string }[]) =>
  new Set(entries.map(entry => entry.id)).size === entries.length;

/** The channels a flow may be authored for (specs/049). */
export const FLOW_CHANNELS = ['whatsapp', 'instagram', 'messenger'] as const;

/**
 * A ManyChat flow is authored for one channel. A string is the flow for
 * `CHANNEL` alone; a map names one per Meta channel (specs/049 § `flowNs` is
 * a string or a map per channel).
 */
const FlowNamespace = z.union([
  z.string().min(1),
  z
    .strictObject({
      whatsapp: z.string().min(1).optional(),
      instagram: z.string().min(1).optional(),
      messenger: z.string().min(1).optional(),
    })
    .refine(map => Object.values(map).some(value => value !== undefined), {
      message: 'a flowNs map names at least one channel',
    }),
]);
export type FlowNamespace = z.infer<typeof FlowNamespace>;

/** Every ManyChat flow a `flowNs` names, on any channel. */
export const namespacesOf = (flowNs: FlowNamespace): string[] =>
  typeof flowNs === 'string'
    ? [flowNs]
    : Object.values(flowNs).filter((value): value is string => value !== undefined);

/**
 * The latest a nudge may be scheduled for: an hour inside WhatsApp's 24-hour
 * window, for the worker's poll, a deferred delivery and the model call. Chosen,
 * not measured (specs/025 § The agent schedules a nudge; it does not send one).
 */
export const MAX_NUDGE_MINUTES = 1380;

/**
 * When the agent may follow up on a lead who went quiet (specs/025). The model
 * names a delay by `id`; `humanActiveTag` names a tag in the tenant's ManyChat
 * account and is never shown to it.
 */
export const NudgeSchema = z.object({
  delays: z
    .array(
      z.object({
        id: ToolEntryId,
        minutes: z
          .number()
          .int()
          .positive()
          .max(MAX_NUDGE_MINUTES, `a nudge delay may not exceed ${MAX_NUDGE_MINUTES} minutes`),
      }),
    )
    .min(1)
    .refine(uniqueIds, 'delay ids must be unique'),
  humanActiveTag: z.string().min(1).optional(),
});
export type Nudge = z.infer<typeof NudgeSchema>;

/** An enum field: the model reads and writes only its configured `values` (specs/012). */
const EnumFieldEntry = z.object({
  id: ToolEntryId,
  field: z.string().min(1),
  // Never free text: a value the model composed would reach a field a
  // flow may render to the contact (specs/012 § Free-text field values
  // are refused).
  values: z
    .array(z.string().min(1))
    .min(1)
    .refine(values => new Set(values).size === values.length, 'values must be unique'),
  description: ToolDescription,
});

const TagEntry = z.object({
  id: ToolEntryId,
  tag: z.string().min(1),
  description: ToolDescription,
});

/**
 * The longest note the agent may write: a ManyChat text field with room to
 * spare. Chosen, not measured (specs/024 § Three free-text notes).
 */
export const MAX_NOTE_LENGTH = 500;

/**
 * The longest a flow may declare it takes to play (specs/030). The reply waits
 * that long after the flow is sent, in a process that has to stay up for it, so
 * the bound is kept short. Chosen, not measured.
 */
export const MAX_SETTLE_SECONDS = 30;

/**
 * A tracking flow the server sends when the funnel advances to `stage`
 * (specs/027). The tenant's flow logs a conversion event and sends no
 * message. The model never sees an entry: not its id, not its flow.
 */
const EventEntry = z.object({
  id: ToolEntryId,
  // `new` is every contact's first stage, so an event on it reports nothing
  // the entry flow does not.
  stage: z
    .enum(FUNNEL_STAGES)
    .refine(stage => stage !== 'new', 'an event may not be keyed on stage "new"'),
  flowNs: FlowNamespace,
});

/**
 * A free-text field the agent may write, which the tenant declares no flow
 * renders to the contact (specs/024, ADR-0017). `neverRendered` checks
 * nothing; it makes the tenant say so in the file.
 */
const NoteEntry = z.object({
  id: ToolEntryId,
  field: z.string().min(1),
  maxLength: z.number().int().positive().max(MAX_NOTE_LENGTH),
  neverRendered: z.literal(true, 'a note must declare "neverRendered": true'),
  /** Still written when the model or the confidence threshold escalates the turn. */
  onEscalation: z.boolean().default(false),
  description: ToolDescription,
});

/** The flows the agent may send, and the rules between them (specs/023, 028, 030, 032). */
const Flows = z
  .array(
    z.object({
      id: ToolEntryId,
      flowNs: FlowNamespace,
      description: ToolDescription,
      /** Exempt from "sent at most once per contact" (specs/023). */
      repeatable: z.boolean().optional(),
      /**
       * `payment_link`: performing it writes the funnel field to `link_sent`
       * (specs/023); with `silent`, the reply carries the link. `opening`:
       * the server sends it on the contact's first model turn, and the
       * model never does (specs/032).
       */
      role: z.enum(['payment_link', 'opening']).optional(),
      /**
       * The funnel stage at which the server sends this flow, when the
       * model records it (specs/032 § A stage move can carry a flow).
       */
      onStage: z
        .enum(FUNNEL_STAGES)
        .refine(
          stage => stage !== 'new' && stage !== 'link_sent',
          'a flow may not be tied to stage "new" or "link_sent"',
        )
        .optional(),
      /**
       * The catalog offering this flow belongs to; absent, it serves every
       * offering (specs/028 § A flow belongs to one offering or to all).
       */
      offering: z.string().min(1).optional(),
      /**
       * How long the flow takes to play in ManyChat, Smart Delays included:
       * the reply that follows it waits this long after it is sent
       * (specs/030). Absent, it does not wait.
       */
      settleSeconds: z.number().int().min(0).max(MAX_SETTLE_SECONDS).optional(),
      /**
       * The flow sends the contact no message: it only records something
       * in ManyChat, such as a tracking event. On the payment-link flow it
       * means the reply carries the link (specs/023 § A silent payment
       * flow leaves the link to the reply).
       */
      silent: z.boolean().optional(),
    }),
  )
  .default([])
  .refine(uniqueIds, 'flow ids must be unique')
  // Nothing plays, so there is nothing for the reply to wait for (specs/030).
  .refine(
    flows => !flows.some(flow => flow.silent && flow.settleSeconds !== undefined),
    'a "silent" flow may not have "settleSeconds"',
  )
  // The opening is the contact's first message from the tenant (specs/032).
  .refine(
    flows => !flows.some(flow => flow.silent && flow.role === 'opening'),
    'the "opening" flow may not be "silent"',
  )
  .refine(
    flows => flows.filter(flow => flow.role === 'payment_link').length <= 1,
    'only one flow may have role "payment_link"',
  )
  // One payment flow serves every offering and branches on the offering
  // field inside ManyChat (specs/028 § One payment flow serves every offering).
  .refine(
    flows => !flows.some(flow => flow.role === 'payment_link' && flow.offering !== undefined),
    'the "payment_link" flow may not have an "offering"',
  )
  // Sent once, to every contact, before anything is known of them
  // (specs/032 § The opening flow is the server's, not the model's).
  .refine(
    flows => flows.filter(flow => flow.role === 'opening').length <= 1,
    'only one flow may have role "opening"',
  )
  .refine(
    flows =>
      !flows.some(
        flow => flow.role === 'opening' && (flow.offering !== undefined || flow.repeatable),
      ),
    'the "opening" flow may not have an "offering" or be "repeatable"',
  )
  .refine(
    flows => !flows.some(flow => flow.role !== undefined && flow.onStage !== undefined),
    'the "opening" and "payment_link" flows may not have an "onStage"',
  )
  .refine(flows => {
    const tied = flows.flatMap(flow => (flow.onStage ? [flow.onStage] : []));
    return new Set(tied).size === tied.length;
  }, 'at most one flow per "onStage"');

/** The enum fields the agent may write, and the marks only one of them may carry (specs/023, 028, 034, 045). */
const Fields = z
  .array(
    EnumFieldEntry.extend({
      /** The field the agent's position in the sale is kept in (specs/023). */
      funnel: z.boolean().optional(),
      /**
       * The field the contact's offering is kept in. Its values must be
       * the catalog's offering ids, checked when the catalog is loaded
       * beside it (specs/028).
       */
      offering: z.boolean().optional(),
      /**
       * On the offering field: the offering stays open to a switch after
       * the offer instead of locking at `offered` (specs/045).
       */
      switchable: z.boolean().optional(),
      /**
       * The field the contact's intent is kept in: until it is `prospect`
       * every sales tool refuses (specs/034).
       */
      intent: z.boolean().optional(),
    }),
  )
  .default([])
  .refine(uniqueIds, 'field ids must be unique')
  .refine(
    fields => fields.filter(field => field.intent).length <= 1,
    'only one field may be marked "intent"',
  )
  .refine(
    fields => !fields.some(field => field.intent && (field.funnel || field.offering)),
    'a field may not be marked both "intent" and "funnel" or "offering"',
  )
  // The values are the system's, as the funnel's stages are (specs/034).
  .refine(
    fields =>
      fields
        .filter(field => field.intent)
        .every(field => field.values.join() === INTENT_VALUES.join()),
    `an "intent" field's values must be ${INTENT_VALUES.join(', ')}, in that order`,
  )
  // A deployment that sells cannot run without the gate (specs/034).
  .refine(
    fields => !fields.some(field => field.funnel) || fields.some(field => field.intent),
    'a field marked "funnel" needs a field marked "intent"',
  )
  .refine(
    fields => fields.filter(field => field.funnel).length <= 1,
    'only one field may be marked "funnel"',
  )
  .refine(
    fields => fields.filter(field => field.offering).length <= 1,
    'only one field may be marked "offering"',
  )
  .refine(
    fields => !fields.some(field => field.funnel && field.offering),
    'a field may not be marked both "funnel" and "offering"',
  )
  .refine(
    fields => fields.every(field => !field.switchable || field.offering),
    'only the field marked "offering" may be "switchable"',
  )
  // Forward-only is decided by position in this list, so a list out of
  // order would let the agent move a lead backwards.
  .refine(
    fields =>
      fields
        .filter(field => field.funnel)
        .every(field => field.values.join() === FUNNEL_STAGES.join()),
    `a "funnel" field's values must be ${FUNNEL_STAGES.join(', ')}, in that order`,
  );

/**
 * The flows, tags and field values the agent may act with (specs/012). The
 * model sees `id` and `description` only; `flowNs`, `tag` and `field` name
 * objects in the tenant's ManyChat account and stay server-side, so renaming
 * one there is a config edit no prompt depends on.
 */
export const ToolsSchema = z
  .object({
    flows: Flows,
    tags: z.array(TagEntry).default([]).refine(uniqueIds, 'tag ids must be unique'),
    fields: Fields,
    /** Absent: `schedule_nudge` is not offered (specs/025). */
    nudge: NudgeSchema.optional(),
    /**
     * Tags and enum fields the tenant's own flows set, which `get_contact`
     * returns but no tool writes (specs/024).
     */
    readable: z
      .object({
        tags: z.array(TagEntry).default([]),
        fields: z.array(EnumFieldEntry).default([]),
      })
      .default({ tags: [], fields: [] }),
    notes: z.array(NoteEntry).default([]).refine(uniqueIds, 'note ids must be unique'),
    /** Conversion events fired on a stage advance, never offered to the model (specs/027). */
    events: z
      .array(EventEntry)
      .default([])
      .refine(uniqueIds, 'event ids must be unique')
      .refine(
        events => new Set(events.map(event => event.stage)).size === events.length,
        'at most one event per stage',
      ),
  })
  // `get_contact` returns writable and readable entries side by side, by id.
  .refine(tools => uniqueIds([...tools.tags, ...tools.readable.tags]), {
    message: 'tag ids must be unique across tags and readable.tags',
    path: ['readable', 'tags'],
  })
  .refine(tools => uniqueIds([...tools.fields, ...tools.readable.fields]), {
    message: 'field ids must be unique across fields and readable.fields',
    path: ['readable', 'fields'],
  })
  // The agent may add or remove any configured tag, so the tag that silences
  // it must not be one of them (specs/025).
  .refine(tools => !tools.tags.some(entry => entry.tag === tools.nudge?.humanActiveTag), {
    message: 'nudge.humanActiveTag may not be a tag the agent writes',
    path: ['nudge'],
  })
  // The opening goes out on the turn that records `prospect`, so without an
  // intent field it never would (specs/034 § The opening waits for a prospect).
  .refine(
    tools =>
      !tools.flows.some(flow => flow.role === 'opening') ||
      tools.fields.some(field => field.intent),
    {
      message: 'an "opening" flow needs a field marked "intent"',
      path: ['flows'],
    },
  )
  // A flow tied to a stage needs a stage to be tied to (specs/032).
  .refine(
    tools => !tools.flows.some(flow => flow.onStage) || tools.fields.some(field => field.funnel),
    {
      message: 'a flow with "onStage" needs a field marked "funnel"',
      path: ['flows'],
    },
  )
  // An event is keyed on a stage, so there must be a stage to key on (specs/027).
  .refine(tools => tools.events.length === 0 || tools.fields.some(field => field.funnel), {
    message: 'events need a field marked "funnel"',
    path: ['events'],
  })
  // A tracking flow that is also a content flow would be sent once by the
  // model and once by the server, and the event would count twice (specs/027).
  // Over every value of a map, whichever channel it sits under (specs/049).
  .refine(
    tools => {
      const events = tools.events.flatMap(event => namespacesOf(event.flowNs));
      const flows = new Set(tools.flows.flatMap(flow => namespacesOf(flow.flowNs)));
      return new Set(events).size === events.length && events.every(ns => !flows.has(ns));
    },
    {
      message: "an event's flowNs may not be a flow's or another event's",
      path: ['events'],
    },
  );
export type Tools = z.infer<typeof ToolsSchema>;
export type Note = Tools['notes'][number];

/** A deployment with no `tools.json`: no tools are offered (specs/012). */
export const NO_TOOLS: Tools = {
  flows: [],
  tags: [],
  fields: [],
  readable: { tags: [], fields: [] },
  notes: [],
  events: [],
};

/** Whether `tools.json` gives the agent anything to act with or read, a follow-up included (specs/025). */
export function offersTools(tools: Tools): boolean {
  return (
    tools.flows.length +
      tools.tags.length +
      tools.fields.length +
      tools.notes.length +
      tools.readable.tags.length +
      tools.readable.fields.length >
      0 || tools.nudge !== undefined
  );
}
