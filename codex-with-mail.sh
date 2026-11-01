#!/bin/sh
# Launch Codex with an explicit per-process MCP configuration; no global config edits.
# Portable: resolves this server and node relative to the invoking machine.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=$(command -v node)
CODEX_BIN=$(command -v codex || echo "$HOME/.local/bin/codex")
exec "$CODEX_BIN" \
  -C "$DIR" \
  -c "mcp_servers.apple-mail-readonly.command=\"$NODE_BIN\"" \
  -c "mcp_servers.apple-mail-readonly.args=[\"$DIR/server.mjs\"]" \
  -c 'mcp_servers.apple-mail-readonly.startup_timeout_sec=20' \
  -c 'mcp_servers.apple-mail-readonly.tool_timeout_sec=60' \
  "$@"
