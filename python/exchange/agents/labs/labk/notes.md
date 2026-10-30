# Maker Lab notebook (labk)

Newest first. This file is the lab's only memory between sessions.

## Start (baseline, written by the builder, not by a session)
Policy v1: base half-spread 1.3 cents, a little wider far from kickoff and tighter near it. Leans both quotes toward where sharp-weighted pressure is (1/10 cent per sharp-weighted contract, capped at 3 cents)
so the lab builds a position on the sharp side, charges more on the side sharp accounts hit, and is tighter and larger on the side public money hits. Pulls quotes on far lines more than a day out.
Nothing tuned yet. First job: run the replay (`python -m exchange.agents backtest exchange/agents/labs/labk/model.py`) and see whether it beats the fixed 1.0 / 1.7 / 3.0 cent baselines on profit per contract and on moves to the close.
