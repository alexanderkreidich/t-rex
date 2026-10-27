#!/usr/bin/env bash
set -euo pipefail

# Run through `bun run test:restty`: the parent check owns one isolated herdr for this lane.
for script in \
  restty-regression \
  terminal-input-regression \
  terminal-safari-ime-regression \
  terminal-ipad-ime-regression \
  terminal-viewport-regression \
  terminal-pinch-regression \
  terminal-command-arrows-regression \
  app-shortcuts-regression \
  terminal-arrows-clicks-regression \
  sticky-modifiers-regression \
  pane-find-regression \
  minimal-ui-regression \
  terminal-keyboard-regression \
  ssp-latency
do
  printf '\n=== %s ===\n' "$script"
  bun "scripts/$script.ts"
done
