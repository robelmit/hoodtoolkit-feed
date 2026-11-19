/**
 * Dollar prices of quote assets. The feed converts with the prices it is
 * given: fixed ones (`QUOTE_PRICES_JSON`), or live ones it refreshes from a
 * source (`QUOTE_PRICE_SOURCE`). A quote asset without a price makes every
 * dollar figure of its tokens `null`; the amounts in base units stay exact.
 * A live price that could not be refreshed for a while is dropped, not kept:
 * a stale price would put wrong dollar figures on every trade.
 */

/** Robinhood Chain's dollar coin, worth one dollar by construction. */
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

export class QuotePrices {
  private readonly byKey = new Map<string, number>();

  /** Prices by symbol (`ETH`) or by address (`0x…`). The dollar coin is priced at 1 unless given. */
  constructor(prices: Readonly<Record<string, number>> = {}) {
    this.byKey.set(USDG, 1);
    for (const [key, usd] of Object.entries(prices)) this.set(key, usd);
  }

  set(key: string, usd: number): void {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) throw new Error(`the price of ${key} must be a positive number`);
    this.byKey.set(QuotePrices.keyOf(key), usd);
  }

  /** Drops a price, so its dollar figures are unknown again. The dollar coin keeps its price of 1. */
  forget(key: string): void {
    const k = QuotePrices.keyOf(key);
    if (k !== USDG) this.byKey.delete(k);
  }

  private static keyOf(key: string): string {
    return key.startsWith('0x') ? key.toLowerCase() : key.toUpperCase();
  }

  /** The price of a quote asset, by its address first and its symbol second; null when neither is known. */
  of(address: string, symbol: string | null): number | null {
    return this.byKey.get(address.toLowerCase()) ?? (symbol ? this.byKey.get(symbol.toUpperCase()) : undefined) ?? null;
  }
}

/** Prices from a JSON object such as `{"ETH":3000}`; throws on anything else, so a typo stops the feed at start. */
export function parsePrices(json: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('QUOTE_PRICES_JSON is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('QUOTE_PRICES_JSON must be an object of symbol or address to price');
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`QUOTE_PRICES_JSON: the price of ${key} must be a positive number`);
    out[key] = value;
  }
  return out;
}

/** Where live prices come from: Coinbase's public spot price, or an https URL answering `{"ETH": 3000}`. */
export type PriceSource = { readonly kind: 'coinbase'; readonly symbols: readonly string[] } | { readonly kind: 'url'; readonly url: string };

/** `coinbase` (ETH), `coinbase:ETH,WETH`, or an https URL; throws on anything else. */
export function parsePriceSource(raw: string): PriceSource {
  const text = raw.trim();
  if (text === 'coinbase') return { kind: 'coinbase', symbols: ['ETH'] };
  if (text.startsWith('coinbase:')) {
    const symbols = text
      .slice('coinbase:'.length)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (!symbols.length || symbols.some((s) => !/^[A-Z0-9]{2,10}$/.test(s))) throw new Error('QUOTE_PRICE_SOURCE: write coinbase:ETH or coinbase:ETH,BTC');
    return { kind: 'coinbase', symbols };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('QUOTE_PRICE_SOURCE is "coinbase" or an https URL answering {"ETH": 3000}');
  }
  if (url.protocol !== 'https:') throw new Error('QUOTE_PRICE_SOURCE: the URL must start with https://');
  return { kind: 'url', url: text };
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** One read of the source: dollar prices by symbol. Throws when the source does not answer with a usable price. */
export async function fetchPrices(source: PriceSource, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<Record<string, number>> {
  const get = async (url: string): Promise<string> => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`the price source answered ${response.status}`);
    return response.text();
  };
  if (source.kind === 'url') return parsePrices(await get(source.url));
  const out: Record<string, number> = {};
  for (const symbol of source.symbols) {
    let body: { data?: { amount?: unknown; currency?: unknown } };
    try {
      body = JSON.parse(await get(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`)) as typeof body;
    } catch (error) {
      throw new Error(`Coinbase, ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const usd = Number(body?.data?.amount);
    if (body?.data?.currency !== 'USD' || !Number.isFinite(usd) || usd <= 0) throw new Error(`Coinbase sent no dollar price for ${symbol}`);
    out[symbol] = usd;
  }
  return out;
}

export interface LivePriceOptions {
  readonly everyMs?: number;
  /** A price not refreshed for this long is dropped (default 10 minutes). */
  readonly staleMs?: number;
  readonly signal: AbortSignal;
  readonly log?: (level: string, message: string, fields?: Record<string, unknown>) => void;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Refreshes `prices` from the source until the signal stops it. The first read is awaited by the caller through
 * `first`, so trades from the start are priced. A failed read keeps the last prices while they are fresh.
 */
export function keepPricesFresh(prices: QuotePrices, source: PriceSource, options: LivePriceOptions): { first: Promise<void>; done: Promise<void> } {
  const now = options.now ?? Date.now;
  const every = options.everyMs ?? 60_000;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const sleep = options.sleep ?? pause;
  const held = new Map<string, number>();
  const once = async (): Promise<void> => {
    try {
      const got = await fetchPrices(source, options.fetch);
      for (const [symbol, usd] of Object.entries(got)) {
        prices.set(symbol, usd);
        held.set(symbol, now());
      }
    } catch (error) {
      options.log?.('warn', 'price refresh failed', { error: error instanceof Error ? error.message : String(error) });
    }
    for (const [symbol, at] of held) {
      if (now() - at > staleMs) {
        prices.forget(symbol);
        held.delete(symbol);
        options.log?.('warn', 'price dropped: not refreshed in time', { symbol });
      }
    }
  };
  const first = once();
  const done = (async () => {
    await first;
    while (!options.signal.aborted) {
      await sleep(every, options.signal);
      if (!options.signal.aborted) await once();
    }
  })();
  return { first, done };
}
