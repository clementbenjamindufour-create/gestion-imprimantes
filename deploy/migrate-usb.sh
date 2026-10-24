#!/bin/sh
set -eu
deploy_root=$(cd "${1:-$HOME/gestion-imprimantes}" && pwd)
usb=${2:-/srv/atelier-data/data}
uuid=${3:?UUID de la cle requis}
[ "$(findmnt -n -o UUID --target "$usb")" = "$uuid" ] || { echo 'Disque USB incorrect.' >&2; exit 1; }
[ ! -e "$deploy_root/storage.env" ] || { echo 'Stockage externe deja configure.' >&2; exit 1; }
[ -d "$usb" ] && [ ! -L "$usb" ] || exit 1
if [ "${4:-}" != '--resume-copy' ]; then
    [ -z "$(podman unshare find "$usb" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo 'Le dossier cible doit etre vide.' >&2; exit 1; }
fi
exec 9>"$deploy_root/.deployment.lock"
flock -n 9 || { echo 'Un deploiement est en cours.' >&2; exit 1; }
cd "$(cat "$deploy_root/current-release")"
set -a
. ./.env
set +a
image="localhost/atelier-backend:$ATELIER_VERSION"
source_dir=$(podman volume inspect gestion-imprimantes_library-data --format '{{.Mountpoint}}')
compose_old() { podman compose --env-file .env -f compose.yaml "$@"; }
mkdir -p "$deploy_root/backups"
backup=$(mktemp "$deploy_root/backups/avant-usb-XXXXXXXX.tar")
success=0
stopped=0
rollback() {
    status=$?
    trap - EXIT
    if [ "$success" -eq 0 ] && [ "$stopped" -eq 1 ]; then
        echo 'Migration echouee : retour au volume original.' >&2
        if [ -f "$deploy_root/storage.env" ]; then
            mv "$deploy_root/storage.env" "$deploy_root/storage.env.failed-$(date +%s)"
        fi
        timeout --kill-after=10 180 podman compose --env-file .env -f compose.yaml up -d --no-build --force-recreate || true
    fi
    exit "$status"
}
trap rollback EXIT
stopped=1
compose_old stop
podman run --rm --network none --pull never --entrypoint python \
    -v gestion-imprimantes_library-data:/data:ro "$image" -c \
    'import sys, tarfile; t=tarfile.open(fileobj=sys.stdout.buffer, mode="w|"); t.add("/data", arcname="data"); t.close()' > "$backup"
echo "Sauvegarde : $backup"
if [ "${4:-}" = '--resume-copy' ]; then
    # Une copie incomplete n'est reutilisee que si son contenu est identique.
    podman unshare diff -qr "$source_dir" "$usb"
fi
podman unshare cp -a "$source_dir/." "$usb/"
podman unshare diff -qr "$source_dir" "$usb"
podman unshare chown 10001:10001 "$usb"
podman run --rm --network none --pull never --entrypoint python -v "$usb:/data" "$image" -c \
    'import sqlite3; c=sqlite3.connect("file:/data/printers.db?mode=rw", uri=True); result=c.execute("PRAGMA integrity_check").fetchall(); assert result==[("ok",)], result; c.close(); print("SQLite : integrite verifiee")'
printf '%s\n' "$uuid" | podman unshare tee "$usb/.atelier-storage-id" > /dev/null
printf "APP_DATA_DIR='%s'\nAPP_STORAGE_UUID='%s'\n" "$usb" "$uuid" > "$deploy_root/storage.env.pending"
mv "$deploy_root/storage.env.pending" "$deploy_root/storage.env"
. ./storage-config.sh
compose config > /dev/null
timeout --kill-after=10 180 podman compose --env-file .env $compose_files up -d --no-build
frontend=$(podman ps -q --filter label=com.docker.compose.project=gestion-imprimantes --filter label=com.docker.compose.service=frontend)
attempt=0
until podman exec "$frontend" wget -q -T 5 -O /dev/null http://127.0.0.1:8080/api/v1/health; do
    attempt=$((attempt+1))
    [ "$attempt" -lt 20 ] || exit 1
    sleep 2
done
success=1
echo 'Migration USB terminee. Ancien volume et sauvegarde conserves.'
