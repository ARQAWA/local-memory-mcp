#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "${SOURCE}" ]; do
  DIR="$(cd "$(dirname "${SOURCE}")" && pwd)"
  TARGET="$(readlink "${SOURCE}")"
  if [[ "${TARGET}" == /* ]]; then
    SOURCE="${TARGET}"
  else
    SOURCE="${DIR}/${TARGET}"
  fi
done
ROOT_DIR="$(cd "$(dirname "${SOURCE}")/.." && pwd)"
exec node "${ROOT_DIR}/dist/index.js" --web "$@"
