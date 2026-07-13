#!/usr/bin/env bash
# Run the lightweight Agent sidebar/tooling regression suite.
#
# This intentionally avoids live LLM calls and Firefox UI automation. It checks
# the parts that can regress during patch/build work: sidebar bundling,
# provider/client request shaping, ToolRouter/AgentLoop dispatch, conversation
# state, thread reservation, and workspace path safety.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDEBAR_DIR="$REPO_ROOT/additions/browser/components/agent-sidebar"

run() {
  echo
  echo "==> $*"
  "$@"
}

run npm --prefix "$SIDEBAR_DIR" run build

SELFTESTS=(
  selftest-config.mjs
  selftest-providers.mjs
  selftest-conversations.mjs
  selftest-stream.mjs
  selftest-retry.mjs
  selftest-anthropic.mjs
  selftest-toolrouter.mjs
  selftest-thread-reservation.mjs
  selftest-workspace.mjs
  selftest-environment.mjs
  selftest-e2e.mjs
)

for test_file in "${SELFTESTS[@]}"; do
  run node "$SIDEBAR_DIR/dev/$test_file"
done

echo
echo "agent tool selftests: all passed"
