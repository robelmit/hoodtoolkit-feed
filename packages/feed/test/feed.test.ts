import { PassThrough } from 'node:stream';
import { ZERO_ADDRESS, addressWord, uintWord, type Erc20Facts, type EvmLog, type EvmRpc } from '@hood-toolkit/evm';
import { PONS_FACTORY, PONS_TOPICS, type Curve } from '@hood-toolkit/pons';
import { describe, expect, it } from 'vitest';
import { FeedEngine, Poller, QuotePrices, STREAM, USDG, jsonlSink, parsePrices, redisSink, type ChainReads, type FeedEvent } from '../src';

const TOKEN = '0x00000000000000000000000000000000000000a2';
const CURVE = '0x00000000000000000000000000000000000000a1';
const TOKEN_B = '0x00000000000000000000000000000000000000b2';
const CURVE_B = '0x00000000000000000000000000000000000000b1';
const DEV = '0x00000000000000000000000000000000000000dd';
const BUYER = '0x00000000000000000000000000000000000000ee';
const E18 = 10n ** 18n;

const topicOf = (a: string): string => `0x${addressWord(a)}`;
let logIndex = 0;
const log = (address: string, topics: string[], words: (bigint | string)[], block = 100, time: number | null = 1_700_000_000): EvmLog => ({
  address,
  topics,
  data: `0x${words.map((w) => (typeof w === 'bigint' ? uintWord(w) : addressWord(w))).join('')}`,
  blockNumber: block,
  transactionHash: `0xtx${logIndex}`,
  logIndex: logIndex++,
  blockTimestamp: time,
});
const launchLog = (token = TOKEN, curve = CURVE, pair = ZERO_ADDRESS, threshold = 42n * E18 / 10n): EvmLog => log(PONS_FACTORY, [PONS_TOPICS.tokenLaunched, topicOf(token), topicOf(curve), topicOf(DEV)], [pair, 1n, threshold]);
const buyLog = (curve = CURVE, quoteIn = E18 / 10n, tokensOut = 20_000n * E18, tax = 0n, recipient = BUYER): EvmLog => log(curve, [PONS_TOPICS.curveBuy, topicOf(recipient), topicOf(recipient)], [quoteIn, tokensOut, quoteIn / 100n, tax], 101);
const sellLog = (curve = CURVE): EvmLog => log(curve, [PONS_TOPICS.curveSell, topicOf(BUYER), topicOf(BUYER)], [10_000n * E18, E18 / 20n, E18 / 2000n, 0n], 102);
const graduationLog = (token = TOKEN): EvmLog => log(PONS_FACTORY, [PONS_TOPICS.poolGraduated, topicOf(token)], [7n, 100n * E18, 4n * E18], 103);

function harness(options: { prices?: Record<string, number>; maxTokens?: number } = {}) {
  let now = 1_700_000_500_000;
  const curves = new Map<string, Curve>();
  const reads: string[] = [];
  const curveOf = (curve: string, token: string, over: Partial<Curve> = {}): Curve => ({
    curve,
    token,
    pairToken: ZERO_ADDRESS,
    native: true,
    pairDecimals: 18,
    pairSymbol: 'ETH',
    tokenDecimals: 18,
    quoteReserve: 2n * E18,
    tokenReserve: 1_000_000_000n * E18,
    sellableTokens: 700_000_000n * E18,
    realQuoteReserve: 0n,
    graduationThreshold: 42n * E18 / 10n,
    feeBps: 100n,
    creatorTaxBps: 0n,
    graduated: false,
    readyToGraduate: false,
    block: 'latest',
    ...over,
  });
  curves.set(CURVE, curveOf(CURVE, TOKEN));
  curves.set(CURVE_B, curveOf(CURVE_B, TOKEN_B, { pairToken: USDG, native: false, pairDecimals: 6, pairSymbol: 'USDG', quoteReserve: 3_236_000_000n, graduationThreshold: 8_090_000_000n }));
  const chain: ChainReads = {
    async erc20(token): Promise<Erc20Facts> {
      reads.push(`erc20:${token}`);
      return { address: token, name: token === TOKEN ? 'Zop Coin' : null, symbol: token === TOKEN ? 'ZOP' : null, decimals: 18, totalSupply: 1_000_000_000n * E18 };
    },
    async curve(curve): Promise<Curve> {
      reads.push(`curve:${curve}`);
      const found = curves.get(curve);
      if (!found) throw new Error('not a curve');
      return found;
    },
    async reserves(curve) {
      reads.push(`reserves:${curve}`);
      const c = curves.get(curve)!;
      return { quoteReserve: c.quoteReserve, tokenReserve: c.tokenReserve, realQuoteReserve: c.realQuoteReserve, graduated: c.graduated };
    },
    async blockTime(block) {
      reads.push(`time:${block}`);
      return 1_700_000_000 + block;
    },
  };
  const engine = new FeedEngine({ reads: chain, prices: new QuotePrices(options.prices ?? { ETH: 3000 }), maxTokens: options.maxTokens, now: () => now });
  const move = (curve: string, change: Partial<Curve>): void => void curves.set(curve, { ...curves.get(curve)!, ...change });
  return { engine, reads, move, tick: (ms: number) => (now += ms) };
}
const types = (events: FeedEvent[]): string[] => events.map((e) => e.type);

describe('the engine', () => {
  it('lists a launch with what the chain says about it', async () => {
    const h = harness();
    const events = await h.engine.apply([launchLog()]);
    expect(types(events)).toEqual(['token_upsert']);
    const event = events[0]!;
    if (event.type !== 'token_upsert') throw new Error('type');
    expect(event).toMatchObject({ v: 1, chain: 'robinhood', reason: 'listed' });
    expect(event.token).toMatchObject({ chain: 'hood', address: TOKEN, symbol: 'ZOP', name: 'Zop Coin', decimals: 18, supply: '1000000000', launchpad: 'pons', stage: 'new', curve: 0, quote: 'ETH', quoteAddress: ZERO_ADDRESS, quoteDecimals: 18, poolAddress: CURVE, creator: DEV, createdAt: 1_700_000_000_000 });
    // 2 ETH against a billion tokens at $3,000: $0.000006 a token, $6,000 market cap.
    expect(event.token.price).toBeCloseTo(0.000006, 12);
    expect(event.token.mc).toBeCloseTo(6000, 6);
    // The same launch again lists nothing.
    expect(await h.engine.apply([launchLog()])).toEqual([]);
  });

  it('publishes a trade with amounts in base units, then a patch of what moved', async () => {
    const h = harness();
    await h.engine.apply([launchLog()]);
    h.move(CURVE, { quoteReserve: 21n * E18 / 10n, tokenReserve: 999_980_000n * E18, realQuoteReserve: E18 / 10n });
    const events = await h.engine.apply([buyLog()]);
    expect(types(events)).toEqual(['market_trade', 'token_patch']);
    const trade = events[0]!;
    if (trade.type !== 'market_trade') throw new Error('type');
    expect(trade.trade).toMatchObject({ chain: 'hood', address: TOKEN, side: 'buy', amountToken: (20_000n * E18).toString(), amountNative: (E18 / 10n).toString(), maker: BUYER, tags: [], route: 'pons', quote: 'ETH', quoteDecimals: 18, at: 1_700_000_000_000 });
    expect(trade.trade.usd).toBeCloseTo(300, 9);
    expect(trade.trade.price).toBeCloseTo(0.015, 12);
    const patch = events[1]!;
    if (patch.type !== 'token_patch') throw new Error('type');
    expect(patch.patch.curve).toBeCloseTo(2.38, 2);
    expect(patch.patch.price).toBeGreaterThan(0.000006);
    expect(h.engine.token(TOKEN)!.curve).toBeCloseTo(2.38, 2);
    // Following a curve costs the light read, not the whole curve again.
    expect(h.reads.filter((r) => r.startsWith('curve:'))).toHaveLength(1);
    expect(h.reads.filter((r) => r.startsWith('reserves:'))).toHaveLength(1);
    // Nothing moved: no patch.
    expect(types(await h.engine.apply([sellLog()]))).toEqual(['market_trade']);
  });

  it('moves a token to bonding at the threshold and to migrated on graduation', async () => {
    const h = harness();
    await h.engine.apply([launchLog()]);
    h.move(CURVE, { realQuoteReserve: 3n * E18 });
    const bonding = await h.engine.apply([buyLog()]);
    const patch = bonding.find((e) => e.type === 'token_patch')!;
    if (patch.type !== 'token_patch') throw new Error('type');
    expect(patch.patch.stage).toBe('bonding');
    const graduated = await h.engine.apply([graduationLog()]);
    expect(types(graduated)).toEqual(['token_remove', 'token_upsert']);
    expect(graduated[0]).toMatchObject({ address: TOKEN, stage: 'bonding', reason: 'migrated' });
    expect(graduated[1]).toMatchObject({ reason: 'migrated', token: { stage: 'migrated', curve: 100 } });
    // Once migrated it stays migrated, and a second graduation log says nothing.
    expect(await h.engine.apply([graduationLog()])).toEqual([]);
    expect(types(await h.engine.apply([buyLog()]))).toEqual(['market_trade']);
    expect(h.engine.token(TOKEN)!.stage).toBe('migrated');
    // A graduation of a token the feed never listed is not invented.
    expect(await h.engine.apply([graduationLog(BUYER)])).toEqual([]);
  });

  it('lists a token seen late on its first trade, and says it was not there for the launch', async () => {
    const h = harness();
    const events = await h.engine.apply([buyLog()]);
    expect(types(events)).toEqual(['token_upsert', 'market_trade']);
    expect(events[0]).toMatchObject({ token: { address: TOKEN, createdAt: null, creator: null } });
    expect(h.engine.getStats()).toMatchObject({ lateListings: 1, trades: 1 });
  });

  it('never prices in a quote asset it has no price for, and never assumes eighteen decimals', async () => {
    const unpriced = harness({ prices: {} });
    const [listed, traded] = [await unpriced.engine.apply([launchLog()]), await unpriced.engine.apply([buyLog()])];
    expect(listed[0]).toMatchObject({ token: { price: null, mc: null } });
    expect(traded[0]).toMatchObject({ trade: { usd: null, price: null, mc: null, amountNative: (E18 / 10n).toString() } });

    // A curve paid in the 6-decimal dollar coin, priced at one dollar without being told.
    const h = harness({ prices: {} });
    const events = await h.engine.apply([launchLog(TOKEN_B, CURVE_B, USDG, 8_090_000_000n), buyLog(CURVE_B, 25_000_000n, 7_000_000n * E18)]);
    const upsert = events[0]!;
    if (upsert.type !== 'token_upsert') throw new Error('type');
    expect(upsert.token).toMatchObject({ quote: 'USDG', quoteAddress: USDG, symbol: TOKEN_B.slice(0, 8) });
    expect(upsert.token.price).toBeCloseTo(0.000003236, 12);
    expect(events[1]).toMatchObject({ trade: { usd: 25, amountNative: '25000000', quote: 'USDG', quoteDecimals: 6 } });
  });

  it('lists a snipe-taxed buy without letting it set a price, and tags the creator\'s own buys', async () => {
    const h = harness();
    await h.engine.apply([launchLog()]);
    const [taxed] = await h.engine.apply([buyLog(CURVE, E18 / 10n, 100n * E18, E18 / 20n)]);
    expect(taxed).toMatchObject({ trade: { tags: ['snipe-taxed'], price: null, mc: null } });
    if (taxed!.type !== 'market_trade') throw new Error('type');
    expect(taxed!.trade.usd).toBeCloseTo(300, 9);
    const [dev] = await h.engine.apply([buyLog(CURVE, E18 / 10n, 20_000n * E18, 0n, DEV)]);
    expect(dev).toMatchObject({ trade: { tags: ['dev'], maker: DEV } });
  });

  it('skips what is not a Pons event, and does not ask twice about a contract that is not a curve', async () => {
    const h = harness();
    const stranger = '0x00000000000000000000000000000000000000ff';
    expect(await h.engine.apply([buyLog(stranger), buyLog(stranger)])).toEqual([]);
    expect(h.reads.filter((r) => r === `curve:${stranger}`)).toHaveLength(1);
    // A launch log from any address but the factory is not a launch.
    expect(await h.engine.apply([{ ...launchLog(), address: stranger }])).toEqual([]);
    expect(await h.engine.apply([{ ...launchLog(), data: '0x' }])).toEqual([]);
    expect(h.engine.getStats().skipped).toBeGreaterThanOrEqual(2);
  });

  it('asks for a block\'s time only when the log does not carry it, and holds at most the tokens it was told to', async () => {
    const h = harness({ maxTokens: 1 });
    const events = await h.engine.apply([{ ...launchLog(), blockTimestamp: null }]);
    expect(h.reads).toContain('time:100');
    expect(events[0]).toMatchObject({ token: { createdAt: (1_700_000_000 + 100) * 1000 } });
    await h.engine.apply([launchLog(TOKEN_B, CURVE_B, USDG)]);
    expect(h.engine.getStats().tokens).toBe(1);
    expect(h.engine.token(TOKEN)).toBeNull();
  });
});

describe('the poller', () => {
  function chain(head: { value: number }, fail: { value: boolean } = { value: false }) {
    const asked: string[] = [];
    const rpc: EvmRpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        if (method === 'eth_blockNumber') return `0x${head.value.toString(16)}` as T;
        if (method !== 'eth_getLogs') throw new Error(method);
        if (fail.value) throw new Error('down');
        const f = params[0] as { address?: string; fromBlock: string; toBlock: string };
        asked.push(`${f.address ? 'factory' : 'trades'}:${Number(BigInt(f.fromBlock))}-${Number(BigInt(f.toBlock))}`);
        return [] as T;
      },
    };
    return { rpc, asked };
  }
  const engineOf = () => harness().engine;

  it('lists recent launches on start, then reads each new block exactly once', async () => {
    const head = { value: 1_000 };
    const { rpc, asked } = chain(head);
    const poller = new Poller({ rpc, engine: engineOf(), publish: async () => undefined, backfillBlocks: 500 });
    await poller.poll();
    expect(asked).toEqual(['factory:500-1000']);
    head.value = 1_025;
    await poller.poll();
    expect(asked.slice(1)).toEqual(['factory:1001-1025', 'trades:1001-1010', 'trades:1011-1020', 'trades:1021-1025']);
    await poller.poll();
    expect(asked).toHaveLength(5);
    expect(poller.getStats()).toMatchObject({ cursor: 1_025, skippedBlocks: 0 });
  });

  it('skips ahead when it is too far behind, and counts what it skipped', async () => {
    const head = { value: 100 };
    const { rpc, asked } = chain(head);
    const warnings: string[] = [];
    const poller = new Poller({ rpc, engine: engineOf(), publish: async () => undefined, backfillBlocks: 0, maxCatchUpBlocks: 20, log: (level, message) => void (level === 'warn' && warnings.push(message)) });
    await poller.poll();
    head.value = 200;
    await poller.poll();
    // Launches and graduations are still read over the whole gap; only trades are skipped.
    expect(asked).toEqual(['factory:101-200', 'trades:181-190', 'trades:191-200']);
    expect(poller.getStats().skippedBlocks).toBe(80);
    expect(warnings).toHaveLength(1);
  });

  it('does not move past blocks it failed to read', async () => {
    const head = { value: 50 };
    const fail = { value: false };
    const { rpc, asked } = chain(head, fail);
    const poller = new Poller({ rpc, engine: engineOf(), publish: async () => undefined, backfillBlocks: 0 });
    await poller.poll();
    head.value = 60;
    fail.value = true;
    await expect(poller.poll()).rejects.toThrow('down');
    expect(poller.getStats().cursor).toBe(50);
    fail.value = false;
    await poller.poll();
    expect(asked).toEqual(['factory:51-60', 'trades:51-60']);
  });

  it('publishes what the engine made of the logs', async () => {
    const head = { value: 10 };
    const rpc: EvmRpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        if (method === 'eth_blockNumber') return `0x${head.value.toString(16)}` as T;
        const f = params[0] as { address?: string };
        const l = launchLog();
        return (f.address ? [{ address: l.address, topics: l.topics, data: l.data, blockNumber: '0x5', transactionHash: '0xaa', logIndex: '0x0', blockTimestamp: '0x65' }] : []) as T;
      },
    };
    const published: FeedEvent[] = [];
    const poller = new Poller({ rpc, engine: engineOf(), publish: async (events) => void published.push(...events), backfillBlocks: 10 });
    await poller.poll();
    expect(types(published)).toEqual(['token_upsert']);
    expect(poller.getStats().published).toBe(1);
  });
});

describe('outputs and prices', () => {
  const event: FeedEvent = { v: 1, ts: 1, chain: 'robinhood', type: 'token_remove', address: TOKEN, stage: 'new', reason: 'migrated' };

  it('writes one JSON line per event', async () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on('data', (c: Buffer) => chunks.push(c.toString()));
    await jsonlSink(out)([event, event]);
    const lines = chunks.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ stream: STREAM, event });
  });

  it('appends to a trimmed Redis Stream', async () => {
    const calls: (string | number)[][] = [];
    await redisSink({ xadd: async (...args) => void calls.push(args) }, 500)([event]);
    expect(calls).toEqual([[STREAM, 'MAXLEN', '~', 500, '*', 'v', '1', 'payload', JSON.stringify(event)]]);
  });

  it('prices by address first, then by symbol, and the dollar coin at one', () => {
    const prices = new QuotePrices({ eth: 3000, '0x00000000000000000000000000000000000000AA': 12 });
    expect(prices.of(ZERO_ADDRESS, 'ETH')).toBe(3000);
    expect(prices.of('0x00000000000000000000000000000000000000aa', 'ETH')).toBe(12);
    expect(prices.of(USDG, null)).toBe(1);
    expect(prices.of(TOKEN, 'META')).toBeNull();
    expect(prices.of(TOKEN, null)).toBeNull();
    expect(() => new QuotePrices({ ETH: 0 })).toThrow(/positive/);
  });

  it('refuses a price list that is not one', () => {
    expect(parsePrices('{"ETH":3000}')).toEqual({ ETH: 3000 });
    expect(() => parsePrices('{bad')).toThrow(/not JSON/);
    expect(() => parsePrices('[1]')).toThrow(/object/);
    expect(() => parsePrices('{"ETH":"3000"}')).toThrow(/positive number/);
    expect(() => parsePrices('{"ETH":-1}')).toThrow(/positive number/);
  });
});
