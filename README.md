# pump-fun-replay-sprint-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/wangconghua/pump-fun-replay-sprint-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/wangconghua/pump-fun-replay-sprint-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the Pump.fun Replay Sprint: it trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Best net PnL wins.

## Strategy

Most pump.fun coins die within minutes, but the ones that run show one signature early — several distinct wallets buying into a rising price over a short window, with the inflow accelerating rather than fading. The bot only buys that signature, starts small (0.03 SOL per position, no pyramiding), and exits in two stages: it banks half the position at +30%, then lets the rest ride a trailing stop, so one runner can pay for many small losers. Losers are cut on a stop-loss, fading flow, a big dump, or a time limit. It never shorts, never uses leverage, and never reads the clock or any randomness — every decision comes from the batch stream, so two runs agree.

## Run it

```sh
node main.ts
```

`main.ts` is the entrypoint (Node 22, type stripping, no build step). The strategy lives in `strategy.ts`; the protocol shim is `vendor/agentfun-bot.ts` (the kit's own SDK file).

## Local results (dev window)

- Official `grade-local` (process driver): **net −0.68 SOL**, 951 fills, 340 coins, 449 round trips, 22% win rate, max drawdown 6.9% — meets the guardrail bar (≥20 coins, ≤50% drawdown) with wide margin.
- The dev window is a hard one: even the house pilot momentum baseline scores −9.38 SOL on it. The final window is different data, collected after entries close.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8max8wdd&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
