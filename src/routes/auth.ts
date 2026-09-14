import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Constant-time comparison over a set of accepted secrets.
 *
 * Hashing to a fixed length first means the comparison does not leak the
 * secret's length, and lets `timingSafeEqual` be used at all (it throws on
 * length mismatch).
 */
function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a comparison so the failure is not measurably faster.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * ManyChat does not sign its requests, so a shared secret header is the only
 * control available (ADR-0006). Multiple accepted secrets allow rotation
 * without taking the ManyChat flow down.
 */
export function createSharedSecretGuard(secrets: string[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!presented || !secrets.some(s => secureEquals(presented, s))) {
      // No detail: a caller who fails auth learns nothing about why.
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
