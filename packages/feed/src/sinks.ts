/** Where events go: lines of JSON, or a Redis Stream. */

import type { Writable } from 'node:stream';
import { STREAM, type FeedEvent } from './wire';

export type Publish = (events: readonly FeedEvent[]) => Promise<void>;

/** One JSON object per line: `{"stream": "...", "event": {...}}`. */
export function jsonlSink(output: Writable): Publish {
  return async (events) => {
    for (const event of events) output.write(`${JSON.stringify({ stream: STREAM, event })}\n`);
  };
}

/** The one Redis command the sink needs; ioredis fits as it is. */
export interface RedisXadd {
  xadd(...args: (string | number)[]): Promise<unknown>;
}

/**
 * Appends to a Redis Stream, trimmed to about `maxLength` entries. Each entry has two fields: `v` (the stream
 * version) and `payload` (the event as JSON).
 */
export function redisSink(client: RedisXadd, maxLength = 30_000, stream: string = STREAM): Publish {
  return async (events) => {
    for (const event of events) await client.xadd(stream, 'MAXLEN', '~', maxLength, '*', 'v', '1', 'payload', JSON.stringify(event));
  };
}
