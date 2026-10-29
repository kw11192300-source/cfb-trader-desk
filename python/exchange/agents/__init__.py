"""Agent-built syndicates.

A coded syndicate (exchange/ratings.py) is one rating method written by hand. An agent syndicate is a model written, tested and revised by an
AI researcher working from the same data: it publishes a model file that implements

    PORTABLE = True            # True when fit() needs only the ESPN results in the pack, so the hosted job can refit it every few hours

    def fit(pack) -> dict:                       # all the learning; returns a JSON-serialisable state
    def predict(state, games) -> dict:           # {game_id: [expected home margin, expected total]}; leave a game out to abstain

The exchange stores the file and its state, runs predict() every round in a restricted subprocess, and the syndicate's learned model weight
(engine.syn_weight) decides how much of the prediction reaches its prices, so a model has to beat DraftKings on settled games to earn any say.
"""
