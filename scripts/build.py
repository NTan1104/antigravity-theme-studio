#!/usr/bin/env python3
"""
Compiles themes/presets.json + runtime/style.css + runtime/engine.js
into a single self-contained payload at dist/bundle.js.
"""

import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
PRESETS_PATH = ROOT_DIR / "themes" / "presets.json"
CSS_PATH = ROOT_DIR / "runtime" / "style.css"
ENGINE_PATH = ROOT_DIR / "runtime" / "engine.js"
DIST_DIR = ROOT_DIR / "dist"
OUT_PATH = DIST_DIR / "bundle.js"


def main() -> int:
    for p in (PRESETS_PATH, CSS_PATH, ENGINE_PATH):
        if not p.exists():
            print(f"[build] Missing required file: {p}", file=sys.stderr)
            return 1

    presets = json.loads(PRESETS_PATH.read_text(encoding="utf-8"))
    css_text = CSS_PATH.read_text(encoding="utf-8")
    engine_src = ENGINE_PATH.read_text(encoding="utf-8")

    presets_marker = "/* __ATS_PRESETS__ */ {}"
    css_marker = "/* __ATS_CSS__ */ ''"

    if presets_marker not in engine_src or css_marker not in engine_src:
        print("[build] Placeholders not found in runtime/engine.js", file=sys.stderr)
        return 1

    bundled = engine_src.replace(
        presets_marker,
        json.dumps(presets, ensure_ascii=False),
        1,
    ).replace(
        css_marker,
        json.dumps(css_text, ensure_ascii=False),
        1,
    )

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(bundled, encoding="utf-8")
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"[build] Built {OUT_PATH} ({size_kb:.1f} KB, {len(presets)} presets)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
