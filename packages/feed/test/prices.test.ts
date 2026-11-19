/** Live quote prices: the source's answer, refreshed; a price that cannot be refreshed in time is dropped. */

import { describe, expect, it } from 'vitest';
import { QuotePrices, USDG, fetchPrices, keepPricesFresh, parsePriceSource } from '../src/prices';

const answer = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

describe('price sources', () => {
  it('reads "coinbase", a symbol list and an https URL, and nothing else', () => {
    expect(parsePriceSource('coinbase')).toEqual({ kind: 'coinbase', symbols: ['ETH'] });
    expect(parsePriceSource('coinbase:eth, btc')).toEqual({ kind: 'coinbase', symbols: ['ETH', 'BTC'] });
    expect(parsePriceSource('https://prices.example/quotes.json')).toEqual({ kind: 'url', url: 'https://prices.example/quotes.json' });
    expect(() => parsePriceSource('http://prices.example')).toThrow(/https/);
    expect(() => parsePriceSource('coinbase:')).toThrow(/coinbase:ETH/);
    expect(() => parsePriceSource('somewhere')).toThrow(/QUOTE_PRICE_SOURCE/);
  });

  it("takes Coinbase's spot price in dollars, and refuses an answer without one", async () => {
    const seen: string[] = [];
    const fetch = async (url: string) => (seen.push(url), answer({ data: { amount: '1805.77', base: 'ETH', currency: 'USD' } })());
    expect(await fetchPrices({ kind: 'coinbase', symbols: ['ETH'] }, fetch)).toEqual({ ETH: 1805.77 });
    expect(seen).toEqual(['https://api.coinbase.com/v2/prices/ETH-USD/spot']);
    await expect(fetchPrices({ kind: 'coinbase', symbols: ['ETH'] }, answer({ data: { amount: '1805', currency: 'EUR' } }))).rejects.toThrow(/no dollar price/);
    await expect(fetchPrices({ kind: 'coinbase', symbols: ['ETH'] }, answer('busy', 503))).rejects.toThrow(/503/);
    expect(await fetchPrices({ kind: 'url', url: 'https://x.example' }, answer({ ETH: 3000 }))).toEqual({ ETH: 3000 });
  });
});

// Reads Coinbase's public spot price once; only with LIVE=1.
describe.runIf(process.env['LIVE'] === '1')('Coinbase spot price, live', () => {
  it('answers a dollar price for ETH', async () => {
    const { ETH } = await fetchPrices({ kind: 'coinbase', symbols: ['ETH'] });
    expect(ETH).toBeGreaterThan(100);
    console.log(`ETH: $${ETH}`);
  });
});

describe('keepPricesFresh', () => {
  it('prices from the first read, keeps the last price through a short outage, and drops it once stale', async () => {
    let now = 0;
    let up = true;
    const ticks: (() => void)[] = [];
    const stop = new AbortController();
    const prices = new QuotePrices();
    const fetch = async () => (up ? answer({ data: { amount: '2000', currency: 'USD' } })() : answer('down', 500)());
    const live = keepPricesFresh(prices, { kind: 'coinbase', symbols: ['ETH'] }, { signal: stop.signal, fetch, now: () => now, staleMs: 600_000, sleep: () => new Promise<void>((resolve) => ticks.push(resolve)) });
    await live.first;
    expect(prices.of('0xweth', 'ETH')).toBe(2000);

    const step = async (ms: number): Promise<void> => {
      now += ms;
      ticks.shift()?.();
      // Let the read after the pause run to its end.
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    up = false;
    await step(60_000);
    expect(prices.of('0xweth', 'ETH')).toBe(2000);
    await step(600_000);
    expect(prices.of('0xweth', 'ETH')).toBeNull();
    // The dollar coin is never dropped.
    expect(prices.of(USDG, 'USDG')).toBe(1);
    up = true;
    await step(60_000);
    expect(prices.of('0xweth', 'ETH')).toBe(2000);
    stop.abort();
    ticks.shift()?.();
    await live.done;
  });
});
