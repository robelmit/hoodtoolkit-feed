/**
 * Logs in, events out. The engine keeps one record per token and turns Pons
 * logs into the feed's events: a launch lists a token, a curve trade becomes
 * a trade and a patch, a graduation moves the token to `migrated`.
 *
 * It reads the chain only through `ChainReads`, so it is tested without one.
 *
 * A trade on a curve whose launch the feed did not see (it started later)
 * lists the token then, with `createdAt: null`: seen late is said, not hidden.
 */

import type { Erc20Facts, EvmLog } from '@hood-toolkit/evm';
import { PONS_FACTORY, PONS_TOPICS, decodeGraduation, decodeLaunch, decodeTrade, isSnipeTaxed, progressPct, spotPrice, type Curve, type CurveReserves, type PonsTrade } from '@hood-toolkit/pons';
import type { QuotePrices } from './prices';
import type { FeedEvent, FeedToken, Stage, TokenPatch } from './wire';

export interface ChainReads {
  erc20(token: string): Promise<Erc20Facts>;
  curve(curve: string): Promise<Curve>;
  /** What trades change on a curve; read after a batch of trades instead of the whole curve. */
  reserves(curve: string): Promise<CurveReserves>;
  /** A block's time in seconds. */
  blockTime(block: number): Promise<number>;
}

export interface EngineOptions {
  readonly reads: ChainReads;
  readonly prices: QuotePrices;
  /** Progress, in percent, at which a token moves from `new` to `bonding` (default 70). */
  readonly bondingThresholdPct?: number;
  /** The most tokens kept; the ones untouched longest go first (default 50,000). */
  readonly maxTokens?: number;
  readonly now?: () => number;
}

interface TokenRecord {
  token: FeedToken;
  curve: string;
  pairDecimals: number | null;
  /** Total supply in base units; null when the token did not say. */
  supplyRaw: bigint | null;
  graduationThreshold: bigint;
}

export interface EngineStats {
  logs: number;
  launches: number;
  trades: number;
  graduations: number;
  lateListings: number;
  /** Logs that looked like Pons events and could not be used (a curve that would not read, a malformed log). */
  skipped: number;
  tokens: number;
}

const toWhole = (raw: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals);
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${raw / scale}.${fraction}` : `${raw / scale}`;
};

/** `raw / 10^decimals` as a number, keeping eighteen digits whatever the size. */
const toNumber = (raw: bigint, decimals: number): number => Number((raw * 10n ** 18n) / 10n ** BigInt(decimals)) / 1e18;

export class FeedEngine {
  private readonly byToken = new Map<string, TokenRecord>();
  private readonly tokenOfCurve = new Map<string, string>();
  /** Curves that would not read as Pons curves: not tried again on every trade. */
  private readonly notCurves = new Set<string>();
  private readonly threshold: number;
  private readonly maxTokens: number;
  private readonly now: () => number;
  private readonly stats: EngineStats = { logs: 0, launches: 0, trades: 0, graduations: 0, lateListings: 0, skipped: 0, tokens: 0 };

  constructor(private readonly options: EngineOptions) {
    this.threshold = options.bondingThresholdPct ?? 70;
    this.maxTokens = Math.max(1, options.maxTokens ?? 50_000);
    this.now = options.now ?? Date.now;
  }

  getStats(): Readonly<EngineStats> {
    return { ...this.stats, tokens: this.byToken.size };
  }

  token(address: string): FeedToken | null {
    return this.byToken.get(address.toLowerCase())?.token ?? null;
  }

  private envelope(): { v: 1; ts: number; chain: 'robinhood' } {
    return { v: 1, ts: this.now(), chain: 'robinhood' };
  }

  private stageOf(progress: number | null, current: Stage): Stage {
    if (current === 'migrated') return 'migrated';
    return progress !== null && progress >= this.threshold ? 'bonding' : 'new';
  }

  private remember(record: TokenRecord): void {
    if (this.byToken.size >= this.maxTokens && !this.byToken.has(record.token.address)) {
      let drop = Math.max(1, Math.floor(this.maxTokens / 10));
      for (const [address, old] of this.byToken) {
        this.byToken.delete(address);
        this.tokenOfCurve.delete(old.curve);
        if (--drop <= 0) break;
      }
    }
    this.byToken.delete(record.token.address);
    this.byToken.set(record.token.address, record);
    this.tokenOfCurve.set(record.curve, record.token.address);
  }

  /** A token's record built from the chain: its own facts and its curve's state. */
  private async build(curveAddress: string, createdAt: number | null, creator: string | null): Promise<TokenRecord> {
    const curve = await this.options.reads.curve(curveAddress);
    const facts = await this.options.reads.erc20(curve.token);
    const quoteUsd = this.options.prices.of(curve.pairToken, curve.pairSymbol);
    const spot = curve.pairDecimals === null ? null : spotPrice(curve, curve.pairDecimals, curve.tokenDecimals);
    const price = spot !== null && quoteUsd !== null ? spot * quoteUsd : null;
    const progress = progressPct(curve.realQuoteReserve, curve.graduationThreshold);
    const supplyRaw = facts.totalSupply;
    const token: FeedToken = {
      chain: 'hood',
      address: curve.token,
      symbol: facts.symbol ?? curve.token.slice(0, 8),
      name: facts.name ?? facts.symbol ?? curve.token.slice(0, 8),
      decimals: curve.tokenDecimals,
      supply: supplyRaw === null ? null : toWhole(supplyRaw, curve.tokenDecimals),
      launchpad: 'pons',
      stage: curve.graduated ? 'migrated' : this.stageOf(progress, 'new'),
      curve: progress,
      quote: curve.pairSymbol,
      quoteAddress: curve.pairToken,
      quoteDecimals: curve.pairDecimals,
      price,
      mc: price !== null && supplyRaw !== null ? price * toNumber(supplyRaw, curve.tokenDecimals) : null,
      poolAddress: curve.curve,
      creator,
      createdAt,
      updatedAt: this.now(),
    };
    return { token, curve: curve.curve, pairDecimals: curve.pairDecimals, supplyRaw, graduationThreshold: curve.graduationThreshold };
  }

  private async timeOf(log: EvmLog): Promise<number> {
    const seconds = log.blockTimestamp ?? (await this.options.reads.blockTime(log.blockNumber));
    return seconds * 1000;
  }

  private tradeEvent(record: TokenRecord, trade: PonsTrade, log: EvmLog, at: number): FeedEvent {
    const token = record.token;
    const quoteUsd = this.options.prices.of(token.quoteAddress, token.quote);
    const quote = record.pairDecimals === null ? null : toNumber(trade.quoteAmount, record.pairDecimals);
    const tokens = toNumber(trade.tokenAmount, token.decimals);
    const usd = quote !== null && quoteUsd !== null ? quote * quoteUsd : null;
    const taxed = trade.side === 'buy' && isSnipeTaxed(trade);
    // A snipe-taxed buy paid a price nobody else could trade at: it is listed, and it prices nothing.
    const price = usd !== null && tokens > 0 && !taxed ? usd / tokens : null;
    return {
      ...this.envelope(),
      type: 'market_trade',
      trade: {
        chain: 'hood',
        address: token.address,
        tx: log.transactionHash,
        at,
        side: trade.side,
        amountToken: trade.tokenAmount.toString(),
        amountNative: trade.quoteAmount.toString(),
        usd,
        price,
        mc: price !== null && record.supplyRaw !== null ? price * toNumber(record.supplyRaw, token.decimals) : null,
        maker: trade.recipient,
        tags: [...(taxed ? ['snipe-taxed'] : []), ...(token.creator !== null && trade.recipient === token.creator ? ['dev'] : [])],
        route: 'pons',
        quote: token.quote,
        quoteDecimals: record.pairDecimals,
      },
    };
  }

  /** Applies a batch of logs, in chain order, and returns the events they make. */
  async apply(logs: readonly EvmLog[]): Promise<FeedEvent[]> {
    const events: FeedEvent[] = [];
    const traded = new Set<string>();

    for (const log of logs) {
      this.stats.logs += 1;
      const topic = log.topics[0];

      if (topic === PONS_TOPICS.tokenLaunched && log.address === PONS_FACTORY) {
        const launch = decodeLaunch(log);
        if (!launch) {
          this.stats.skipped += 1;
          continue;
        }
        if (this.byToken.has(launch.token)) continue;
        try {
          const record = await this.build(launch.curve, await this.timeOf(log), launch.deployer);
          this.remember(record);
          this.stats.launches += 1;
          events.push({ ...this.envelope(), type: 'token_upsert', token: record.token, reason: 'listed' });
        } catch {
          this.stats.skipped += 1;
        }
        continue;
      }

      if (topic === PONS_TOPICS.curveBuy || topic === PONS_TOPICS.curveSell) {
        const trade = decodeTrade(log);
        if (!trade || this.notCurves.has(log.address)) {
          if (!trade) this.stats.skipped += 1;
          continue;
        }
        let address = this.tokenOfCurve.get(log.address);
        if (!address) {
          // A curve launched before the feed started: list its token now, and say it was seen late.
          try {
            const record = await this.build(log.address, null, null);
            this.remember(record);
            this.stats.lateListings += 1;
            events.push({ ...this.envelope(), type: 'token_upsert', token: record.token, reason: 'listed' });
            address = record.token.address;
          } catch {
            // Anything can emit a log with this topic; a contract that does not read as a curve is not one.
            this.notCurves.add(log.address);
            if (this.notCurves.size > 20_000) this.notCurves.clear();
            this.stats.skipped += 1;
            continue;
          }
        }
        const record = this.byToken.get(address)!;
        this.stats.trades += 1;
        events.push(this.tradeEvent(record, trade, log, await this.timeOf(log)));
        traded.add(address);
        continue;
      }

      if (topic === PONS_TOPICS.poolGraduated && log.address === PONS_FACTORY) {
        const graduation = decodeGraduation(log);
        const record = graduation ? this.byToken.get(graduation.token) : undefined;
        if (!graduation) this.stats.skipped += 1;
        if (!record || record.token.stage === 'migrated') continue;
        this.stats.graduations += 1;
        const before = record.token.stage;
        record.token = { ...record.token, stage: 'migrated', curve: 100, updatedAt: this.now() };
        traded.delete(record.token.address);
        events.push({ ...this.envelope(), type: 'token_remove', address: record.token.address, stage: before, reason: 'migrated' });
        events.push({ ...this.envelope(), type: 'token_upsert', token: record.token, reason: 'migrated' });
      }
    }

    // One read per curve that traded: where the curve stands after the batch.
    for (const address of traded) {
      const record = this.byToken.get(address);
      if (!record || record.token.stage === 'migrated') continue;
      let reserves: CurveReserves;
      try {
        reserves = await this.options.reads.reserves(record.curve);
      } catch {
        continue;
      }
      const progress = progressPct(reserves.realQuoteReserve, record.graduationThreshold);
      const quoteUsd = this.options.prices.of(record.token.quoteAddress, record.token.quote);
      const spot = record.pairDecimals === null ? null : spotPrice(reserves, record.pairDecimals, record.token.decimals);
      const price = spot !== null && quoteUsd !== null ? spot * quoteUsd : null;
      const mc = price !== null && record.supplyRaw !== null ? price * toNumber(record.supplyRaw, record.token.decimals) : null;
      // A curve that reports itself graduated stays where it is until the factory's event moves the token.
      const stage = this.stageOf(progress, record.token.stage);
      const patch: { -readonly [K in keyof TokenPatch]: TokenPatch[K] } = {};
      if (progress !== record.token.curve) patch.curve = progress;
      if (price !== record.token.price) patch.price = price;
      if (mc !== record.token.mc) patch.mc = mc;
      if (stage !== record.token.stage) patch.stage = stage;
      record.token = { ...record.token, ...patch, updatedAt: this.now() };
      if (Object.keys(patch).length > 0) events.push({ ...this.envelope(), type: 'token_patch', address, patch: { ...patch, updatedAt: record.token.updatedAt } });
    }
    return events;
  }
}
