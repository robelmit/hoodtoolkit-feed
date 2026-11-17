/**
 * Follows the chain: on a timer, reads the new blocks' Pons logs and hands
 * them to the engine. Launches and graduations come from the factory, so they
 * are read by address over long ranges; trades come from per-token curves,
 * so they are read by topic over short ones.
 *
 * It keeps no history. On start it can list the launches of the last blocks
 * (`backfillBlocks`), so trades on those curves are attributed at once;
 * trades themselves are followed from the head.
 */

import { FILTERED_LOG_SPAN, UNFILTERED_LOG_SPAN, blockNumber, getLogs, type EvmLog, type EvmRpc } from '@hood-toolkit/evm';
import { PONS_FACTORY, PONS_TOPICS } from '@hood-toolkit/pons';
import type { FeedEngine } from './engine';
import type { FeedEvent } from './wire';

export interface PollerOptions {
  readonly rpc: EvmRpc;
  readonly engine: FeedEngine;
  readonly publish: (events: readonly FeedEvent[]) => Promise<void>;
  /** Time between polls, in milliseconds (default 2,000). */
  readonly pollMs?: number;
  /** Launches of this many past blocks are listed on start (default 100,000; 0 for none). */
  readonly backfillBlocks?: number;
  /** The most blocks of trades read in one poll; a feed further behind than this skips ahead and says so (default 600). */
  readonly maxCatchUpBlocks?: number;
  /** Blocks of trade logs per call (default 10, what the public endpoint serves without an address). */
  readonly tradeSpan?: number;
  readonly log?: (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;
}

export interface PollerStats {
  polls: number;
  head: number | null;
  cursor: number | null;
  /** Blocks of trades skipped because the feed fell too far behind. Not zero means trades were missed. */
  skippedBlocks: number;
  failedPolls: number;
  published: number;
}

const FACTORY_TOPICS = [[PONS_TOPICS.tokenLaunched, PONS_TOPICS.poolGraduated]];
const TRADE_TOPICS = [[PONS_TOPICS.curveBuy, PONS_TOPICS.curveSell]];

const inOrder = (logs: EvmLog[]): EvmLog[] => logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

export class Poller {
  private cursor: number | null = null;
  private readonly stats: PollerStats = { polls: 0, head: null, cursor: null, skippedBlocks: 0, failedPolls: 0, published: 0 };

  constructor(private readonly options: PollerOptions) {}

  getStats(): Readonly<PollerStats> {
    return { ...this.stats, cursor: this.cursor };
  }

  private say(level: 'info' | 'warn', message: string, fields?: Record<string, unknown>): void {
    this.options.log?.(level, message, fields);
  }

  private async emit(logs: EvmLog[]): Promise<void> {
    if (logs.length === 0) return;
    const events = await this.options.engine.apply(inOrder(logs));
    if (events.length === 0) return;
    await this.options.publish(events);
    this.stats.published += events.length;
  }

  /** Lists the launches of the last blocks, then sets the cursor at the head. */
  async start(): Promise<void> {
    const head = await blockNumber(this.options.rpc);
    const back = this.options.backfillBlocks ?? 100_000;
    if (back > 0) {
      const from = Math.max(0, head - back);
      const launches = await getLogs(this.options.rpc, { address: PONS_FACTORY, topics: FACTORY_TOPICS }, from, head, FILTERED_LOG_SPAN);
      this.say('info', 'listing recent launches', { fromBlock: from, toBlock: head, logs: launches.length });
      await this.emit(launches);
    }
    this.cursor = head;
    this.stats.head = head;
  }

  /** One poll: everything between the cursor and the head. */
  async poll(): Promise<void> {
    if (this.cursor === null) await this.start();
    this.stats.polls += 1;
    const head = await blockNumber(this.options.rpc);
    this.stats.head = head;
    let from = this.cursor! + 1;
    if (head < from) return;
    const max = this.options.maxCatchUpBlocks ?? 600;
    // The factory's events are read over the whole gap, so no launch or graduation is lost by skipping ahead.
    const factory = await getLogs(this.options.rpc, { address: PONS_FACTORY, topics: FACTORY_TOPICS }, from, head, FILTERED_LOG_SPAN);
    if (head - from + 1 > max) {
      const skipped = head - from + 1 - max;
      this.stats.skippedBlocks += skipped;
      this.say('warn', 'the feed fell behind; trades of the skipped blocks are not published', { skippedBlocks: skipped });
      from = head - max + 1;
    }
    const trades = await getLogs(this.options.rpc, { topics: TRADE_TOPICS }, from, head, this.options.tradeSpan ?? UNFILTERED_LOG_SPAN);
    await this.emit([...factory, ...trades]);
    this.cursor = head;
  }

  /** Polls until `signal` aborts. A failed poll is logged and tried again; the cursor does not move, so nothing is lost. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.stats.failedPolls += 1;
        this.say('warn', 'a poll failed; it will be tried again', { error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollMs ?? 2_000);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}
