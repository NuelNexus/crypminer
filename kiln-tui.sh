#!/bin/sh
# Kiln in the terminal (Linux / macOS). Run with sudo for huge pages and the MSR tweak.
cd "$(dirname "$0")" && exec node app/tui.js "$@"
