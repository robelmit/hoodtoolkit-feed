# hoodtoolkit-feed

A launch feed for Robinhood Chain, from the team behind the Hexa trading terminal. It follows Pons and publishes every launch from the moment it happens, every trade on a bonding curve, progress and graduations, as one stream of events.

| Package | What it does |
|---|---|
| [`@hoodtoolkit/feed`](packages/feed) | The feed as a library and as the `hoodtoolkit-feed` command: standard output or a Redis Stream, from an RPC endpoint alone |

```bash
QUOTE_PRICES_JSON='{"ETH":3000}' npx @hoodtoolkit/feed
```

The [community bots](https://github.com/robelmit/hoodtoolkit-bots) and the [agent tools](https://github.com/robelmit/hoodtoolkit-agents) read its stream.

## Principles

- **Nothing here signs, sends or holds a key.**
- **Unknown is never zero.** A value that could not be read stays `null`.
- **Read, never assume.** Pons sets the graduation threshold and the paired asset per launch, and pairs tokens with ETH, a 6-decimal dollar coin, or tokenized stocks.
- **No API key needed.** Everything runs against a Robinhood Chain RPC endpoint you choose.

## Develop

Node 22.13 or newer and pnpm to work on the repository; the published packages run on Node 20 or newer.

This repository uses packages of [hoodtoolkit-sdk](https://github.com/robelmit/hoodtoolkit-sdk). Until those are on npm, clone it beside this one and run `pnpm install && pnpm build` there first; `.pnpmfile.cjs` then links the local copies.

```bash
pnpm install
pnpm check        # build, typecheck, test, lint
```

## The hoodtoolkit family

| Repository | What it holds |
|---|---|
| [hoodtoolkit-sdk](https://github.com/robelmit/hoodtoolkit-sdk) | The Pons SDK and the shared EVM client |
| **hoodtoolkit-feed** (this one) | The launch feed: launches, curve trades and graduations as a stream of events |
| [hoodtoolkit-bots](https://github.com/robelmit/hoodtoolkit-bots) | Telegram and Discord community bots |
| [hoodtoolkit-agents](https://github.com/robelmit/hoodtoolkit-agents) | A read-only MCP server for AI agents, and an HTTP API |

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

[MIT](LICENSE)
