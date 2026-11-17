/**
 * The events the feed publishes. A figure the feed cannot know is `null` or
 * absent, never zero: a trade in a quote asset that has no price has
 * `usd: null`, and a token nobody priced yet has `price: null`.
 *
 * Token amounts are integer strings in base units.
 */

export type Stage = 'new' | 'bonding' | 'migrated';

export interface FeedToken {
  /** Always `hood`: the chain's short id. */
  readonly chain: 'hood';
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Whole tokens, as a decimal string; null when the token did not report a supply. */
  readonly supply: string | null;
  readonly launchpad: 'pons';
  readonly stage: Stage;
  /** Progress toward graduation, 0 to 100. */
  readonly curve: number | null;
  /** The quote asset's symbol (ETH, USDG, a tokenized stock…); null when it does not report one. */
  readonly quote: string | null;
  /** The quote asset's address; the zero address is the native coin. */
  readonly quoteAddress: string;
  /** The quote asset's decimals: 18 for the native coin; null when the asset does not report them. */
  readonly quoteDecimals: number | null;
  /** US dollars per token; null without a price for the quote asset. */
  readonly price: number | null;
  readonly mc: number | null;
  /** The token's curve contract while it is on the curve. */
  readonly poolAddress: string;
  readonly creator: string | null;
  /** When it launched, in milliseconds; null when the feed did not see the launch. */
  readonly createdAt: number | null;
  readonly updatedAt: number;
}

export interface FeedTrade {
  readonly chain: 'hood';
  readonly address: string;
  readonly tx: string;
  readonly at: number;
  readonly side: 'buy' | 'sell';
  /** Token base units. */
  readonly amountToken: string;
  /** Quote-asset base units (wei for ETH). */
  readonly amountNative: string;
  readonly usd: number | null;
  /** US dollars per token as this trade paid; null without a quote price, and for a snipe-taxed buy. */
  readonly price: number | null;
  readonly mc: number | null;
  readonly maker: string;
  readonly tags: readonly string[];
  readonly route: 'pons';
  /** The quote asset `amountNative` is counted in: its symbol and decimals, null when it does not report them. */
  readonly quote: string | null;
  readonly quoteDecimals: number | null;
}

export type TokenPatch = Partial<Pick<FeedToken, 'stage' | 'curve' | 'price' | 'mc' | 'updatedAt'>>;

interface Envelope {
  readonly v: 1;
  /** When the event was published, in milliseconds. */
  readonly ts: number;
  /** Always `robinhood`: the stream's chain. */
  readonly chain: 'robinhood';
}

export type FeedEvent =
  | (Envelope & { readonly type: 'token_upsert'; readonly token: FeedToken; readonly reason: 'listed' | 'migrated' })
  | (Envelope & { readonly type: 'token_patch'; readonly address: string; readonly patch: TokenPatch })
  | (Envelope & { readonly type: 'token_remove'; readonly address: string; readonly stage: Stage; readonly reason: 'migrated' })
  | (Envelope & { readonly type: 'market_trade'; readonly trade: FeedTrade });

/** The Redis Stream the events go to, and the name JSON lines carry. */
export const STREAM = 'stream:market:robinhood';
