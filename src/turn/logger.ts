export interface TurnLogger {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
}

/**
 * Every line about a turn names its conversation by the row's random ID, and
 * nothing derived from the subscriber ID (ADR-0014).
 */
export function withConversation(logger: TurnLogger, conversation: string): TurnLogger {
  return {
    info: (fields, message) => logger.info({ conversation, ...fields }, message),
    warn: (fields, message) => logger.warn({ conversation, ...fields }, message),
    error: (fields, message) => logger.error({ conversation, ...fields }, message),
  };
}
