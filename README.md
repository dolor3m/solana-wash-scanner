# Washline

Heuristic scanner for wash-style circular trading on a Solana token.

It reads recent swaps from the busiest one or two DEX pools, then scores wallets that buy and sell back through themselves. A high score means the sampled tape is inventory-neutral and fast. It is not proof of wash trading. Market makers on liquid pools can look similar, and the score is discounted when that is likely.

No API key. Node 22 talks to the public Solana RPC and DexScreener.

## Run

```bash
node --experimental-strip-types src/cli.ts DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
node --experimental-strip-types src/cli.ts BONK
node --experimental-strip-types --test src/lib/wash/detect.test.ts
```

The command prints one JSON report.

## What it treats as circular

A wallet is flagged when all of these are true:

- It is at least 4% of the sampled dollars.
- Buy dollars and sell dollars match (about 55% or better, 70% for a two-trade loop).
- The trades sit close together (median gap under 3 minutes, or the whole loop fits in 15 minutes).

The score starts at that round-trip share times 64.

- Repeated clip size on those wallets adds 8.
- One round-trip wallet above 45% of the sample adds 6.
- A liquid pool (at least $250k) with 30 or more wallets is discounted, because market makers sit inventory-neutral too.
- A thin tape (12 wallets or fewer) with real circular share is marked up slightly.
- Fewer than 8 swaps caps the score at 40.

## What it does not see

- Swaps where a router holds the tokens and the signer’s balance never changes.
- Prints under $0.20.
- Washes that use a fresh wallet for every trade, unless those wallets also sign a round trip.
- Trades outside the one or two pools in the sample.
- Funding links between wallets.

Mint authority and freeze authority are reported next to the score. They are control risks, not wash signals, and they do not change the number.

## Pools

Ticker search follows 24h volume, not the pool with the most idle liquidity. A fake pool can show a deep book and almost no trading.
