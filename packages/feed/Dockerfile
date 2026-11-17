# The Robinhood Chain launch feed as an image. Build from the repository root:
#
#   docker build -f packages/feed/Dockerfile -t hoodtoolkit-feed .
#
# It installs @hoodtoolkit/evm and @hoodtoolkit/pons from npm, so it builds once they are published.
#   docker run --rm -e QUOTE_PRICES_JSON='{"ETH":3000}' hoodtoolkit-feed
#
# Every setting is an environment variable; packages/feed/README.md lists them.

FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages packages
# The feed with the packages it uses; ioredis comes with its development dependencies, for SINK=redis.
RUN pnpm install --frozen-lockfile --filter "@hoodtoolkit/feed..." \
 && pnpm --filter "@hoodtoolkit/feed..." build
WORKDIR /repo/packages/feed
USER node
CMD ["node", "dist/cli.js"]
