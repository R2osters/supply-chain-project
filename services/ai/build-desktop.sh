#!/usr/bin/env bash
# Builds the SCIP AI desktop sidecar (dist/scip-ai/scip-ai) with PyInstaller on macOS and Linux.
#
# The same steps as build-desktop.ps1, which builds scip-ai.exe on Windows: a build venv with the
# pinned interpreter, the runtime dependencies only, then the shared scip-ai.spec.
# Idempotent: reuses .venv-build when it exists and rebuilds from a clean build/ and dist/scip-ai/.
#
#   bash services/ai/build-desktop.sh
#
# PYTHON names the interpreter (default python3.12: every pinned wheel exists for cp312 on
# macOS arm64 and Linux x86_64, so nothing falls back to a source build).
set -euo pipefail

PYTHON="${PYTHON:-python3.12}"
PYINSTALLER_VERSION="${PYINSTALLER_VERSION:-6.19.0}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$root/.venv-build"
python="$venv/bin/python"
cd "$root"

if [ ! -x "$python" ]; then
  echo "Creating build venv with $("$PYTHON" --version)..."
  "$PYTHON" -m venv "$venv"
fi

# Runtime dependencies only: the "# Dev / test" block of requirements.txt (pytest...) is cut so it
# cannot end up in the bundle. The filtered copy lives in build/.
mkdir -p build
sed '/^# Dev \/ test$/,$d' requirements.txt > build/requirements-runtime.txt

echo 'Installing runtime dependencies...'
"$python" -m pip install --disable-pip-version-check -q \
  -r build/requirements-runtime.txt "pyinstaller==$PYINSTALLER_VERSION"

echo 'Running PyInstaller...'
"$python" -m PyInstaller --noconfirm --clean \
  --distpath dist --workpath build/pyinstaller scip-ai.spec

echo "Built $root/dist/scip-ai/scip-ai ($(du -sh dist/scip-ai | cut -f1))"
