/**
 * `hoodtoolkit-feed`: the launch feed as a process. Every setting is an environment variable.
 *
 *   HOOD_RPC_URL        the endpoint (default: Robinhood Chain's public one, which rate-limits)
 *   SINK                jsonl | redis                 (default jsonl, to standard output)
 *   REDIS_URL           required with SINK=redis
 *   STREAM_MAX_LENGTH   entries kept in the stream     (default 30000)
 *   QUOTE_PRICES_JSON   e.g. {"ETH":3000}             (fixed dollar prices of quote assets; absent = dollar figures unknown)
 *   QUOTE_PRICE_SOURCE  coinbase | coinbase:ETH,BTC | https://…  (live prices, refreshed every minute; dropped when stale)
 *   QUOTE_PRICE_REFRESH_SECONDS  time between refreshes (default 60)
 *   RPC_PER_SECOND      calls a second to the endpoint (default 20; 0 for no pacing, on a node of your own)
 *   POLL_MS             time between polls             (default 2000)
 *   BACKFILL_BLOCKS     launches listed on start       (default 100000; 0 for none)
 *   BONDING_THRESHOLD   progress % for new -> bonding  (default 70)
 *   RUN_SECONDS         stop after this many seconds   (for a trial run)
 *
 * Events go to standard output; everything else goes to standard error.
 */

import { ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC, blockTime, chainId, createEvmRpc, readErc20 } from '@hood-toolkit/evm';
import { readCurve, readReserves } from '@hood-toolkit/pons';
import { FeedEngine } from './engine';
import { Poller } from './poller';
import { QuotePrices, keepPricesFresh, parsePriceSource, parsePrices } from './prices';
import { jsonlSink, redisSink, type Publish, type RedisXadd } from './sinks';

const say = (level: string, message: string, fields: Record<string, unknown> = {}): void => void process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...fields })}\n`);

async function main(): Promise<void> {
  const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
  const whole = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is a whole number from ${min} to ${max}`);
    return value;
  };

  const url = env('HOOD_RPC_URL') ?? ROBINHOOD_PUBLIC_RPC;
  const rpc = createEvmRpc({ url, requestsPerSecond: whole('RPC_PER_SECOND', 20, 0, 10_000) });
  const id = await chainId(rpc);
  if (id !== ROBINHOOD_CHAIN_ID) throw new Error(`HOOD_RPC_URL serves chain ${id}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);

  const prices = new QuotePrices(env('QUOTE_PRICES_JSON') ? parsePrices(env('QUOTE_PRICES_JSON')!) : {});
  const stop = new AbortController();
  const sink = env('SINK') ?? 'jsonl';
  let publish: Publish;
  if (sink === 'jsonl') {
    publish = jsonlSink(process.stdout);
  } else if (sink === 'redis') {
    const redisUrl = env('REDIS_URL');
    if (!redisUrl) throw new Error('REDIS_URL is required with SINK=redis');
    if (!/^rediss?:\/\//.test(redisUrl)) throw new Error('REDIS_URL must start with redis:// or rediss://');
    let Redis: new (url: string) => RedisXadd & { on(event: 'error', listener: (error: Error) => void): unknown; disconnect(): void };
    try {
      const name = 'ioredis';
      ({ Redis } = (await import(name)) as { Redis: typeof Redis });
    } catch {
      throw new Error('SINK=redis needs the "ioredis" package: npm i ioredis');
    }
    const redis = new Redis(redisUrl);
    redis.on('error', (error) => say('warn', 'redis', { error: error.message }));
    stop.signal.addEventListener('abort', () => redis.disconnect(), { once: true });
    publish = redisSink(redis, whole('STREAM_MAX_LENGTH', 30_000, 100, 10_000_000));
  } else {
    throw new Error(`SINK is "${sink}": use jsonl or redis`);
  }

  // A block's time is asked for once per block, not once per log.
  const times = new Map<number, number>();
  // A token's name, symbol and decimals do not change: each is read once.
  const facts = new Map<string, ReturnType<typeof readErc20>>();
  const erc20 = (token: string): ReturnType<typeof readErc20> => {
    const key = token.toLowerCase();
    let known = facts.get(key);
    if (!known) {
      known = readErc20(rpc, key);
      // A failed read is not kept, so the next ask tries again.
      known.catch(() => facts.delete(key));
      if (facts.size > 100_000) facts.clear();
      facts.set(key, known);
    }
    return known;
  };
  const engine = new FeedEngine({
    prices,
    bondingThresholdPct: whole('BONDING_THRESHOLD', 70, 1, 100),
    reads: {
      erc20,
      curve: (curve) => readCurve(rpc, curve, 'latest', erc20),
      reserves: (curve) => readReserves(rpc, curve),
      blockTime: async (block) => {
        const known = times.get(block);
        if (known !== undefined) return known;
        const time = await blockTime(rpc, block);
        if (times.size > 5_000) times.clear();
        times.set(block, time);
        return time;
      },
    },
  });
  const poller = new Poller({ rpc, engine, publish, pollMs: whole('POLL_MS', 2_000, 250, 600_000), backfillBlocks: whole('BACKFILL_BLOCKS', 100_000, 0, 5_000_000), log: say });

  const shutdown = (): void => {
    if (stop.signal.aborted) return;
    say('info', 'stopping', { ...engine.getStats(), ...poller.getStats() });
    stop.abort();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const seconds = env('RUN_SECONDS') ? whole('RUN_SECONDS', 0, 1, 86_400) : 0;
  if (seconds > 0) setTimeout(shutdown, seconds * 1000).unref();

  const priceSource = env('QUOTE_PRICE_SOURCE') ? parsePriceSource(env('QUOTE_PRICE_SOURCE')!) : null;
  if (priceSource) {
    const live = keepPricesFresh(prices, priceSource, { everyMs: whole('QUOTE_PRICE_REFRESH_SECONDS', 60, 10, 3_600) * 1000, signal: stop.signal, log: say });
    // Trades from the first poll on are priced when the source answers at once; if it does not, they stay unknown.
    await live.first;
  }

  const priced = priceSource ? `live from ${priceSource.kind === 'coinbase' ? `Coinbase (${priceSource.symbols.join(', ')})` : new URL(priceSource.url).host}` : env('QUOTE_PRICES_JSON') ? 'given' : 'none: dollar figures will be null except for the dollar coin';
  say('info', 'feed starting', { sink, endpoint: new URL(url).host, pricedQuotes: priced });
  await poller.run(stop.signal);
}

main().catch((error: unknown) => {
  say('error', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
