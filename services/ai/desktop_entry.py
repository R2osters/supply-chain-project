"""Desktop sidecar entrypoint for the SCIP AI service.

The desktop app (Tauri supervisor, see docs/desktop-architecture.md) launches the frozen
``scip-ai.exe`` built from this file instead of ``uvicorn app.main:app``. The supervisor picks a
free port and passes it in, so nothing here may assume port 8000 is available.

Configuration, highest priority first:
  --host / --port            command-line flags
  SCIP_AI_HOST / SCIP_AI_PORT environment
  127.0.0.1 / 8000           defaults

Everything else (AI_SERVICE_TOKEN, DATABASE_URL, MODELS_STORE, REQUIRE_AUTH...) is read by
``app.config.Settings`` from the environment, which the supervisor fills in.
"""

from __future__ import annotations

import argparse
import multiprocessing
import os
import sys
from pathlib import Path


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="scip-ai", description="SCIP AI service (desktop sidecar)")
    parser.add_argument("--host", default=os.environ.get("SCIP_AI_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SCIP_AI_PORT", "8000")))
    parser.add_argument("--log-level", default=os.environ.get("SCIP_AI_LOG_LEVEL", "info"))
    return parser.parse_args(argv)


def _apply_desktop_defaults() -> None:
    """Environment defaults that only make sense for the installed desktop build."""
    if getattr(sys, "frozen", False) and "MODELS_STORE" not in os.environ:
        # The Settings default is a path relative to the working directory, which for an
        # installed exe is the install folder (%LOCALAPPDATA%\SCIP), where data does not belong
        # and which an update replaces. Fall back to the desktop app's data root instead; the
        # supervisor normally sets MODELS_STORE itself.
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        os.environ["MODELS_STORE"] = str(Path(base) / "com.scip.desktop" / "models")

    # joblib (pulled in by scikit-learn) shells out to wmic/powershell to count physical cores
    # the first time a model is fitted. That costs about a second, and from a windowless sidecar
    # it can flash a console. Logical cores are close enough for this workload.
    os.environ.setdefault("LOKY_MAX_CPU_COUNT", str(os.cpu_count() or 1))


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    _apply_desktop_defaults()

    # Imported after the environment is settled: app.main reads Settings at import time.
    import uvicorn

    from app.main import app

    # The app object is passed directly rather than as "app.main:app" so PyInstaller sees the
    # import statically. No reload and one worker: reload needs the source tree and a watcher,
    # and extra workers would re-spawn the exe for no gain (the solvers already use native
    # threads inside OR-Tools and numpy). WebSockets are off because no endpoint uses them.
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        workers=1,
        reload=False,
        ws="none",
        log_level=args.log_level,
        access_log=False,
    )


if __name__ == "__main__":
    # Required before anything else in a frozen Windows build: if a library ever starts a
    # multiprocessing child, the child re-runs this exe and must stop here, not start a server.
    multiprocessing.freeze_support()
    main()
