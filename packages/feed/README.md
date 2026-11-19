# @hood-toolkit/feed

A launch feed for Robinhood Chain. It follows Pons and publishes one stream of events: a token was launched, it traded, its curve moved, it graduated.

It shows tokens **from the moment of launch**, while they are still on the bonding curve. It needs only an RPC endpoint: no key, no database.

```
npx @hood-toolkit/feed
```

That prints events to standard output, one JSON object per line, from the chain's public endpoint.

## What it publishes

Every event has `v`, `type`, `ts` (when it was published, in milliseconds) and `chain` (`robinhood`).

| `type` | Meaning | Fields |
|---|---|---|
| `token_upsert` | A token was listed, or it graduated and its whole record is sent again | `token`, `reason` (`listed`, `migrated`) |
| `market_trade` | One trade on a curve | `trade` |
| `token_patch` | Some fields of a token changed; only those are sent | `address`, `patch` |
| `token_remove` | A token left a stage | `address`, `stage`, `reason` (`migrated`) |

A listing, as the feed printed it (prices with ETH set to $3,000):

```json
{
  "v": 1, "ts": 1794887479904, "chain": "robinhood", "type": "token_upsert", "reason": "listed",
  "token": {
    "chain": "hood", "address": "0xd9c47f26d5f591a7c5fa6ac2575384f27adfff58",
    "symbol": "CHAOTIC", "name": "Chaotic Order", "decimals": 18, "supply": "1000000000",
    "launchpad": "pons", "stage": "new", "curve": 0.3,
    "quote": "ETH", "quoteAddress": "0x0000000000000000000000000000000000000000", "quoteDecimals": 18,
    "price": 0.000005116494063, "mc": 5116.494063,
    "poolAddress": "0xa61cc799e98bbf50b304128fc6b78135730514ca",
    "creator": "0x27665533d7a1bd4c40c03eb36f1484653fb10bd6",
    "createdAt": 1794884537000, "updatedAt": 1794887479904
  }
}
```

A trade, here paid in the dollar coin:

```json
{
  "v": 1, "ts": 1794887542992, "chain": "robinhood", "type": "market_trade",
  "trade": {
    "chain": "hood", "address": "0xb84740cf7455d51cbe7111ddd90cbc6ca9a14eae",
    "tx": "0xa0504545798bcb39881acb28fcb3712842b47956d42b5db9f2a17b400e46eb66",
    "at": 1794887482000, "side": "buy",
    "amountToken": "305839684020229059687884", "amountNative": "1000000",
    "usd": 1, "price": 0.000003269686872727273, "mc": 3269.686872727273,
    "maker": "0x5bbe3adb4e5fc0747d7b261acea5be4fc157692c", "tags": [], "route": "pons",
    "quote": "USDG", "quoteDecimals": 6
  }
}
```

### Units

- `amountToken` and `amountNative` are integer strings in base units. `amountNative` is the quote asset named by the trade's `quote` and `quoteDecimals`: wei for ETH, 6-decimal units for the dollar coin.
- `supply` is whole tokens, as a string.
- `price`, `mc` and `usd` are US dollars, and `null` when the quote asset has no price.
- `curve` is progress toward graduation, 0 to 100.

### What `null` means

**Unknown is never zero.**

- A token paired with an asset you gave no price for has `price: null`, and its trades have `usd: null`.
- A token the feed first saw on a trade, because it launched before the feed started, has `createdAt: null` and `creator: null`.
- A buy in the first seconds after a launch can carry a large snipe tax. It is published with the tag `snipe-taxed` and `price: null`: what it paid is real, and nobody else could trade at it.

## Prices in dollars

The feed converts with prices you give it, fixed or live. For a long run, use a live source:

```
QUOTE_PRICE_SOURCE=coinbase npx @hood-toolkit/feed          # ETH from Coinbase's public spot price, every minute
QUOTE_PRICE_SOURCE=https://you.example/prices.json …        # your own URL answering {"ETH": 3000}
QUOTE_PRICES_JSON='{"ETH":3000}' npx @hood-toolkit/feed     # fixed, for a trial run
```

Keys are symbols or addresses. The chain's dollar coin (USDG) counts as one dollar. Pons tokens are also paired with tokenized stocks and other tokens; without a price for those, their dollar figures are `null` and the base-unit amounts are still exact.

A live price that cannot be refreshed keeps its last value for ten minutes and is then dropped, so dollar figures turn `null` instead of going wrong. Use one source per asset: when a live price is dropped, a fixed one for the same asset goes with it. Without any price for ETH, trades paid in ETH have no dollar value: the bots post no buy for them and leave them out of trending.

## Output

`SINK=jsonl` (the default) prints `{"stream": "stream:market:robinhood", "event": {...}}` per line. Logs go to standard error, so the output can be piped.

`SINK=redis` appends to the Redis Stream `stream:market:robinhood`. Each entry has two fields: `v` (`1`) and `payload` (the event as JSON). It needs the `ioredis` package.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `HOOD_RPC_URL` | The public endpoint | Your Robinhood Chain endpoint. The feed checks it serves chain 4663 |
| `RPC_PER_SECOND` | `20` | Calls a second; `0` for no pacing on a node of your own |
| `SINK` | `jsonl` | `jsonl` or `redis` |
| `REDIS_URL` | — | Required with `SINK=redis` |
| `STREAM_MAX_LENGTH` | `30000` | Entries kept in the stream |
| `QUOTE_PRICES_JSON` | — | Fixed dollar prices of quote assets |
| `QUOTE_PRICE_SOURCE` | — | Live prices: `coinbase` (ETH), `coinbase:ETH,BTC`, or an https URL answering `{"ETH": 3000}` |
| `QUOTE_PRICE_REFRESH_SECONDS` | `60` | Time between live refreshes, from 10 to 3,600 |
| `POLL_MS` | `2000` | Time between polls |
| `BACKFILL_BLOCKS` | `100000` | Launches of this many past blocks are listed on start; `0` for none |
| `BONDING_THRESHOLD` | `70` | Progress at which `new` becomes `bonding` |
| `RUN_SECONDS` | — | Stop after this many seconds |

## How it follows the chain

The chain makes about ten blocks a second.

- **Launches and graduations** come from the Pons factory, so they are read by address. That works over long ranges, and none is lost even when the feed falls behind.
- **Trades** come from each token's own curve contract, so they are read by event type with no address. The public endpoint serves that over about ten blocks at a time.
- After a batch of trades, each curve that traded is read once for its new progress and price.

On the public endpoint, in a trial run, trades were published between about 6 and 20 seconds after they happened, the longest while the feed was still listing recent launches at start. On an endpoint of your own it is limited by your poll interval.

If the feed falls more than 600 blocks behind, it skips ahead and says so on standard error; the count of skipped blocks is in its stats. Trades in skipped blocks are not published. A poll that fails is tried again from the same block.

## As a library

```ts
import { FeedEngine, Poller, QuotePrices, jsonlSink } from '@hood-toolkit/feed';
```

`FeedEngine` turns logs into events and reads the chain only through the `ChainReads` you give it. `Poller` follows the chain. `jsonlSink` and `redisSink` are the outputs. `src/cli.ts` shows them wired together.

## What it does not do

- **It stops at graduation.** After a token graduates it trades in a Uniswap v4 pool; those trades are not followed.
- **No history.** It lists the launches of the last blocks on start and follows from the head. It does not backfill trades.
- **No holders, no safety checks, no candles.** It publishes trades; a reader builds the rest.
- **Pons V2 only.** Other launchpads on the chain are not covered yet.
- **Its state is in memory.** A restart starts over.

## Tests

```
pnpm --filter @hood-toolkit/feed test
```

16 tests drive the engine and the poller with faked chain reads. The process was also run against the public endpoint: it listed launches paired with ETH, the dollar coin and another token, and published live trades.

## Licence

MIT
