#!/usr/bin/env bash
# Runs inside a clean distribution image (desktop-unix.yml, job linux-distributions), started with
#   docker run --rm --init -v "$PWD:/repo:ro" <image> bash /repo/apps/desktop/scripts/e2e-linux-container.sh
#
# The image has nothing of the build: what the package declares as dependencies must be enough.
# The .deb is installed with apt, as a user would, then the same end-to-end check runs with the
# Node.js runtime the package embeds.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y /repo/dist/SCIP-*-linux-amd64.deb
# Only what the check itself needs on top of the package: a display and a session bus.
apt-get install -y --no-install-recommends xvfb xauth dbus

# The check runs with a copy of the embedded Node.js, taken out of the package: at start-up SCIP
# stops whatever runs from its own resources without a SCIP above it, and that would be the check.
install -m 755 /usr/lib/SCIP/resources/node/node /usr/local/bin/node

# An X server started by an ordinary account cannot create the folder its socket lives in.
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# PostgreSQL refuses to run as root, and nobody runs SCIP as root.
useradd --create-home scip
runuser -u scip -- env HOME=/home/scip \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a dbus-run-session -- \
  node /repo/apps/desktop/scripts/e2e-unix.mjs
