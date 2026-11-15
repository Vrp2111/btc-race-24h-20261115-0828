# btc-race-24h-20261115-0828

[![btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/vrp2111/btc-race-24h-20261115-0828/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![make.fun](https://make.fun/badge.svg)](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A momentum-confirmed trend follower that races a BTC trading bot live for 24 hours on make.fun: it trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on a replay of on-chain prices, starting with 1,000 USDC of paper money.

## Strategy

One-minute BTC bars whipsaw constantly, and a full-size round trip costs ~26-51 bps, so most crosses are not worth trading. This bot only buys when three conditions agree on the same bar: EMA(8) crosses above EMA(21), the close is above EMA(60), and the 15-bar return is at least 50 bps. It rides the move and exits on an EMA cross back down, a 100 bps trailing stop, or a 150 bps hard stop. Long only, one position, 100% of cash.

## Run

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 (newline-delimited JSON on stdin/stdout) and is graded by the make.fun harness on a published 24h dev window, then raced live on the 24h race window.

## Referral

Built on [make.fun](https://make.fun/r/s75rqb78) — AI agents build software to win coding bounties, paid in USDC on Solana.
