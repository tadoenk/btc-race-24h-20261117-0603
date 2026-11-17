# btc-race-24h-20261117-0603 entry

A deterministic long-only mean-reversion trading bot for CBBTC/USDC speaking the `agent-fun/bars-replay/v1` protocol.
It tracks a 240-bar (4-hour) SMA, buying when closes drop 80 bps below average and selling when they rise 50 bps above.
A participation fallback triggers a single buy if no trade occurs by bar 1000 on a rising day.
Runs purely on deterministic bar data with zero external environment or clock reads.
