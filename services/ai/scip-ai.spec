# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the SCIP AI desktop sidecar (scip-ai.exe).

Build with build-desktop.ps1, not by hand: it pins the interpreter (3.12, the version every pinned
wheel exists for) and installs runtime dependencies only.

onedir rather than onefile: onefile unpacks ~hundreds of MB of numpy/scipy/OR-Tools into %TEMP%
on every launch, which adds seconds to each start and leaves debris when the supervisor kills
the process. The installer ships the folder anyway, so a single file buys nothing.
"""

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)


def _no_tests(name: str) -> bool:
    # Test packages of the scientific stack are large and never imported at runtime.
    return ".tests" not in name and ".testing" not in name and not name.endswith(".conftest")


hiddenimports = []
datas = []
binaries = []

# uvicorn resolves its loop, protocol and lifespan implementations from strings
# ("uvicorn.protocols.http.httptools_impl"...), which static analysis cannot follow.
hiddenimports += collect_submodules("uvicorn")

# The scientific packages lazily import compiled submodules; the contrib hooks cover most of
# them, but listing the submodules explicitly (minus tests) means a library bump cannot quietly
# drop one and turn into an ImportError on a customer's machine at the first forecast.
for package in ("sklearn", "scipy", "statsmodels", "pandas"):
    hiddenimports += collect_submodules(package, filter=_no_tests)
    datas += collect_data_files(package, excludes=["**/tests/**"])

# OR-Tools ships its solvers as DLLs next to the Python bindings (ortools/.libs).
hiddenimports += collect_submodules("ortools", filter=_no_tests)
datas += collect_data_files("ortools")
binaries += collect_dynamic_libs("ortools")

a = Analysis(
    ["desktop_entry.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Nothing in app/ plots or opens a window; these get pulled in transitively by
    # pandas/statsmodels optional code paths and would add tens of MB.
    excludes=[
        "tkinter",
        "matplotlib",
        "IPython",
        "jupyter",
        "notebook",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "pytest",
        "_pytest",
        "pytest_asyncio",
        "tests",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="scip-ai",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX is off: it slows start-up (every DLL is decompressed on load) and antivirus engines
    # flag UPX-packed binaries far more often.
    upx=False,
    # Console subsystem so stdout/stderr reach the supervisor's pipes for logging; the
    # supervisor spawns it with CREATE_NO_WINDOW so no console is shown to the user.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="scip-ai",
)
