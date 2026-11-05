"""Configure a user's own DeepSeek key for local mode."""
from getpass import getpass
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

data = Path(__file__).resolve().parent.parent / ".data" / "experience"
key = getpass("DeepSeek API key (hidden): ").strip()
if not key:
    raise SystemExit("No key entered.")
data.mkdir(mode=0o700, parents=True, exist_ok=True)
with NamedTemporaryFile(mode="w", dir=data, delete=False) as tmp:
    json.dump({"baseUrl": "https://api.deepseek.com/v1",
               "model": "deepseek-flash", "apiKey": key}, tmp)
os.replace(tmp.name, data / "model-config.json")
print("Saved locally. Restart the local service to apply.")
