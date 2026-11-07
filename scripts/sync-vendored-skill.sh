#!/usr/bin/env bash
# Re-vendor skills/ncu-report-skill from a local clone of upstream.
#
#   scripts/sync-vendored-skill.sh ~/src/ncu-report-skill
#
# Rewrites VENDORED.yaml with the new revision. Review the diff before commit:
# the vendored content is upstream-owned and must stay verbatim.
set -euo pipefail

SOURCE=${1:?usage: $0 <path-to-ncu-report-skill-clone>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/skills/ncu-report-skill"
REVISION=$(git -C "$SOURCE" rev-parse HEAD)
DATE=$(git -C "$SOURCE" log -1 --format=%cs)

rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$SOURCE" archive HEAD | tar -x -C "$DEST"
rm -f "$DEST/.gitignore"

cat > "$DEST/VENDORED.yaml" <<EOF
# Provenance record for this vendored skill. Rewritten by scripts/sync-vendored-skill.sh.
source: https://github.com/mit-han-lab/ncu-report-skill.git
revision: $REVISION
revision_date: $DATE
license: MIT
sync: scripts/sync-vendored-skill.sh
EOF

echo "vendored ncu-report-skill @ $REVISION ($DATE)"
