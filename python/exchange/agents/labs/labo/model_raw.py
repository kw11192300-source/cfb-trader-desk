"""The v1 ratings without the DraftKings blend (for blend_study)."""
from exchange.agents.labs.labo.model import fit  # noqa: F401
from exchange.agents.labs.labo import model as _m

def predict(state, games):
    return _m.predict(state, [{**g, "dk": None} for g in games])
