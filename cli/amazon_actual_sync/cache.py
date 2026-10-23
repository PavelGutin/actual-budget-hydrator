import json
from pathlib import Path
from typing import Optional

DEFAULT_CACHE_DIR = Path(".cache")


def _ensure_dir(cache_dir: Path):
    cache_dir.mkdir(parents=True, exist_ok=True)


def read_json(cache_dir: Path, key: str) -> Optional[dict]:
    path = cache_dir / f"{key}.json"
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def write_json(cache_dir: Path, key: str, data) -> None:
    _ensure_dir(cache_dir)
    path = cache_dir / f"{key}.json"
    with open(path, "w") as f:
        json.dump(data, f)
