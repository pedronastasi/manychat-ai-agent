import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Constant-time comparison over a set of accepted secrets.
 *
 * Hashing to a fixed length first means the comparison does not leak the
 * secret's length, and lets `timingSafeEqual` be used at all (it throws on
 * length mismatch).
 */
function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    // Still burn a comparison so the failure is not measurably faster.
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/** The credential in an `Authorization: Bearer` header, if there is one. */
export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** Whether the request carries one of the accepted shared secrets. */
export function isAuthenticated(request: FastifyRequest, secrets: string[]): boolean {
  const presented = bearerToken(request.headers.authorization);
  return presented !== undefined && secrets.some(secret => secureEquals(presented, secret));
}

/**
 * ManyChat does not sign its requests, so a shared secret header proves the
 * caller (ADR-0012). Multiple accepted secrets allow rotation without taking
 * the ManyChat flow down.
 *
 * Runs as an `onRequest` hook, before the body is parsed: a caller with no
 * credential must learn nothing about the schema from a validation error
 * (specs/017 § Authentication runs before the body is read).
 */
export function createSharedSecretGuard(secrets: string[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isAuthenticated(request, secrets)) {
      // No detail: a caller who fails auth learns nothing about why.
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
