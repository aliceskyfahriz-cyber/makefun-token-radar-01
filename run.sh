#!/bin/sh
# Regenerate out/ from the dev snapshot (input/snapshot.json).
# Usage: ./run.sh
#   MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR may be set to override the
#   input and output directories (see README.md).
set -e
cd "$(dirname "$0")"
node main.ts
