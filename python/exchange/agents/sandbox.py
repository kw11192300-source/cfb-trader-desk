"""Runs an agent's model file in a separate process with a clean environment (no database keys, no tokens), a time limit, and its network
and process modules blocked. This is a guard against accidents and casual misuse, not a hard security boundary: the model code is written by
our own agents and reviewed on publish, and it runs where the rest of the repository already runs."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PY_ROOT = str(Path(__file__).resolve().parents[2])

BOOT = r"""
import sys, json, importlib.util, traceback
sys.path.insert(0, sys.argv[2])
d = sys.argv[1]
for m in ("numpy", "pandas", "scipy", "scipy.sparse", "scipy.sparse.linalg", "scipy.stats", "scipy.optimize", "sklearn", "sklearn.linear_model", "sklearn.ensemble", "joblib", "statsmodels.api"):
    try:
        __import__(m)
    except Exception:
        pass
DENY = {"socket", "ssl", "http", "urllib3", "requests", "httpx", "aiohttp", "ftplib", "smtplib", "telnetlib", "webbrowser", "supabase", "postgrest", "subprocess", "multiprocessing", "ctypes"}
for name in list(sys.modules):
    if name.split(".")[0] in DENY:
        del sys.modules[name]
class Deny:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in DENY:
            raise ImportError("module not allowed in agent models: " + name)
sys.meta_path.insert(0, Deny())
req = json.load(open(d + "/args.json"))
try:
    spec = importlib.util.spec_from_file_location("agent_model", d + "/model.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = req["fn"]
    if fn == "meta":
        out = {"portable": bool(getattr(mod, "PORTABLE", False)), "has_fit": hasattr(mod, "fit"), "has_predict": hasattr(mod, "predict")}
    elif fn == "fit":
        from exchange.agents.pack import Pack
        p = req["pack"]
        out = mod.fit(Pack(p["root"], p.get("asof"), p.get("lines_ok", True)))
    elif fn == "predict":
        out = mod.predict(req["state"], req["games"])
    else:
        raise ValueError("unknown fn " + fn)
    json.dump({"ok": True, "out": out}, open(d + "/result.json", "w"), default=float)
except Exception:
    json.dump({"ok": False, "error": traceback.format_exc()[-3000:]}, open(d + "/result.json", "w"))
"""


class ModelError(Exception):
    pass


def call(code: str, fn: str, timeout: int = 900, **payload):
    """Run `fn` ('meta' | 'fit' | 'predict') of the model source `code`; returns its JSON-serialisable result or raises ModelError."""
    with tempfile.TemporaryDirectory(prefix="agentmodel_") as d:
        Path(d, "model.py").write_text(code, encoding="utf-8")
        Path(d, "args.json").write_text(json.dumps({"fn": fn, **payload}, default=str), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "COMSPEC")}
        env["PYTHONHASHSEED"] = "0"
        try:
            r = subprocess.run([sys.executable, "-c", BOOT, d, PY_ROOT], cwd=d, env=env, timeout=timeout, capture_output=True, text=True)
        except subprocess.TimeoutExpired:
            raise ModelError(f"{fn} took longer than {timeout} s")
        res = Path(d, "result.json")
        if not res.exists():
            raise ModelError(f"{fn} crashed: {(r.stderr or r.stdout)[-1500:]}")
        j = json.loads(res.read_text(encoding="utf-8"))
        if not j["ok"]:
            raise ModelError(j["error"])
        return j["out"]
