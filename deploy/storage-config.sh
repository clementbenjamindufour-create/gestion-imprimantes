# Source depuis le dossier d'une release, avec deploy_root defini.
compose_files='-f compose.yaml'
data_source=gestion-imprimantes_library-data
if [ -f "$deploy_root/storage.env" ]; then
    . "$deploy_root/storage.env"
    : "${APP_DATA_DIR:?Dossier de stockage manquant}"
    : "${APP_STORAGE_UUID:?UUID de stockage manquant}"
    actual_uuid=$(findmnt -n -o UUID --target "$APP_DATA_DIR")
    if [ "$actual_uuid" != "$APP_STORAGE_UUID" ]; then
        echo 'La cle USB attendue est absente : deploiement refuse.' >&2
        exit 1
    fi
    if [ "$(cat "$APP_DATA_DIR/.atelier-storage-id")" != "$APP_STORAGE_UUID" ]; then
        echo 'Identite du dossier USB incorrecte.' >&2
        exit 1
    fi
    export APP_DATA_DIR APP_STORAGE_UUID
    compose_files='-f compose.yaml -f compose.usb.yaml'
    data_source=$APP_DATA_DIR
fi
# compose_files contient uniquement les options fixes ci-dessus.
compose() { podman compose --env-file .env $compose_files "$@"; }
