#!/bin/sh
set -eu
cd "$(dirname "$0")"
release_dir=$(pwd)
deploy_root=$(cd ../.. && pwd)
command -v flock >/dev/null || { echo 'flock (util-linux) est requis sur le serveur.' >&2; exit 1; }
# Le noyau libere ce verrou meme apres une interruption brutale.
# Ne jamais supprimer ce fichier pendant qu'un deploiement est actif.
exec 9>"$deploy_root/.deployment.lock"
flock -n 9 || { echo 'Un deploiement est deja en cours.' >&2; exit 1; }
if [ -d "$deploy_root/.deployment-lock" ]; then
    echo 'Ancien verrou present : verifier les anciens processus avant de retirer le dossier .deployment-lock.' >&2
    exit 1
fi
. ./storage-config.sh
podman compose version
podman load --input backend.tar
podman load --input frontend.tar
compose config > /dev/null
podman image exists "localhost/atelier-backend:$1"
podman image exists "localhost/atelier-frontend:$1"
mkdir -p "$deploy_root/backups"

# Stoppe aussi une installation issue du compose de developpement (meme projet).
if [ "$data_source" != gestion-imprimantes_library-data ] || podman volume exists gestion-imprimantes_library-data; then
    compose stop
    backup=$(mktemp "$deploy_root/backups/$(basename "$release_dir")-XXXXXXXX.tar")
    echo "Sauvegarde des donnees : $backup"
    # L'image chargee contient Python ; aucun telechargement sur le serveur.
    if ! podman run --rm --network none --pull never --entrypoint python \
        --volume "$data_source:/data:ro" \
        "localhost/atelier-backend:$1" -c \
        'import sys, tarfile; t = tarfile.open(fileobj=sys.stdout.buffer, mode="w|"); t.add("/data", arcname="data"); t.close()' > "$backup"; then
        echo 'Sauvegarde echouee, redemarrage de la version existante.' >&2
        compose start
        exit 1
    fi
fi

if ! timeout --kill-after=10 180 podman compose --env-file .env $compose_files up -d --no-build; then
    echo "Deploiement echoue. Consulter les logs et la sauvegarde dans $deploy_root/backups." >&2
    exit 1
fi
# Wget est deja present dans l'image Nginx : aucun curl requis sur l'hote.
frontend=$(podman ps -q --filter label=com.docker.compose.project=gestion-imprimantes --filter label=com.docker.compose.service=frontend)
if [ -z "$frontend" ]; then
    echo 'Conteneur frontend introuvable apres le demarrage.' >&2
    compose logs --tail 80
    exit 1
fi
attempt=0
until podman exec "$frontend" wget -q -T 5 -O /dev/null http://127.0.0.1:8080/api/v1/health; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        compose logs --tail 80
        echo 'La verification de sante a echoue. Les donnees sauvegardees sont conservees.' >&2
        exit 1
    fi
    sleep 2
done
printf '%s\n' "$release_dir" > "$deploy_root/current-release"
echo 'Deploiement termine, API operationnelle.'
