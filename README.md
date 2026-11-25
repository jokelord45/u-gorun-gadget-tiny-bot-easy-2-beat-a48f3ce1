[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/jokelord45/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/jokelord45/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# Tiny Bot — Trend Rotator

A paper-trading bot for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty on [make.fun](https://make.fun). It trades $10,000 of paper USDC across 7 Solana assets on hourly bars.

## Strategy

Hold only the strongest uptrending names, sit in cash otherwise: a symbol is bought only while its fast EMA sits above its slow EMA and its 24h return is positive, and the bot holds the top 4 such names by 24h return, rebalanced every 6 bars. It sells the moment the trend breaks (close under the slow EMA) or a position slips 4% under its cost, and never chases a symbol already up more than 25% in 24h. In a falling window that keeps it mostly in cash; in a rising window it rides the winners instead of the whole universe.

## Local grade (kit's own grader, dev window)

`node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process`

Net **−$31.27** (−0.31%) on the dev window, 16 trades, 0.40% max drawdown, result `4c861dffcfce0bb20dccd9ac9c9c5d10cdbb47e5be5a63c55ab65c24baba93a6`. That beats buy-and-hold (−$869.34, −8.69%) by $838.06 and every house baseline except macd-cci (−$20.22), while meeting the guardrails (≥8 trades, ≤25% drawdown). The dev window falls the whole way, so the edge here is staying mostly in cash (2% exposure): the two dip entries it took both lost a little, and the bot refused everything else. The final window is a fresh 72 bars — in a rising window the same dip entries ride the winners instead.

## Run

```sh
node main.ts
```

Node 22.18+ (the grader runs Node 22.23.4), standard library only, no dependencies, no network, no clock, no randomness — deterministic by construction, so the two grading executions agree byte for byte.

## Layout

- `main.ts` — entrypoint: runs the strategy through the replay shim.
- `strategy.ts` — the trend-rotator strategy (all tunable parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bars.ts` — the kit's `agent-fun/bars-replay/v1` bot shim, copied unchanged from the kit's SDK.
