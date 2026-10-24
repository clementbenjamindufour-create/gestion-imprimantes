#!/bin/sh
set -eu
if [ -z "${PRINTERS_STORAGE_ID:-}" ] || [ ! -f /data/.atelier-storage-id ] ||
    [ "$(cat /data/.atelier-storage-id)" != "$PRINTERS_STORAGE_ID" ]; then
    echo 'Stockage USB absent ou incorrect : demarrage refuse.' >&2
    exit 1
fi
exec sh /app/entrypoint.sh
