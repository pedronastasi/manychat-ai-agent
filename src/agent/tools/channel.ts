import type { FlowNamespace, Tools } from '../../contracts/config.ts';

type Flow = Tools['flows'][number];
type Event = Tools['events'][number];

/** `tools.json` as one channel sees it: every flow and event resolved to its namespace there. */
export type ChannelTools = Omit<Tools, 'flows' | 'events'> & {
  flows: (Omit<Flow, 'flowNs'> & { flowNs: string })[];
  events: (Omit<Event, 'flowNs'> & { flowNs: string })[];
};

/**
 * The flow authored for `channel`, if any. A string is the flow for
 * `defaultChannel` alone (specs/049 § `flowNs` is a string or a map per
 * channel), and nothing falls back to another channel's.
 */
export function flowOn(
  flowNs: FlowNamespace,
  channel: string,
  defaultChannel: string,
): string | undefined {
  if (typeof flowNs === 'string') return channel === defaultChannel ? flowNs : undefined;
  return (flowNs as Partial<Record<string, string>>)[channel];
}

function onChannel<T extends { flowNs: FlowNamespace }>(
  entries: T[],
  channel: string,
  defaultChannel: string,
): (Omit<T, 'flowNs'> & { flowNs: string })[] {
  return entries.flatMap(entry => {
    const flowNs = flowOn(entry.flowNs, channel, defaultChannel);
    return flowNs === undefined ? [] : [{ ...entry, flowNs }];
  });
}

/**
 * Only the flows and events the turn's channel has. A flow missing here is
 * neither offered nor sent on this turn, by the model or the server: the
 * opening, a stage-tied flow, the payment link and an event alike (specs/049
 * § A turn sees only the flows its channel has).
 */
export function toolsOn(tools: Tools, channel: string, defaultChannel: string): ChannelTools {
  return {
    ...tools,
    flows: onChannel(tools.flows, channel, defaultChannel),
    events: onChannel(tools.events, channel, defaultChannel),
  };
}
