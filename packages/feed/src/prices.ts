/**
 * Dollar prices of quote assets. The feed fetches none: it converts with the
 * prices it is given. A quote asset without a price makes every dollar figure
 * of its tokens `null`; the amounts in base units stay exact.
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
    this.byKey.set(key.startsWith('0x') ? key.toLowerCase() : key.toUpperCase(), usd);
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
