# Gestion des imprimantes 3D

Application locale pour conserver des fichiers slicés, suivre les tentatives
d'impression et leurs notes, puis piloter une Ender 3 et une ELEGOO Mars 4 Ultra.

- Backend : Python / FastAPI / SQLite — [installation](backend/README.md).
- Frontend : Angular, avec bibliothèque, projets et notes.
- Serveur cible : Dell Wyse 5010, 4 Go de RAM, Linux.

Le backend permet d'importer et télécharger des fichiers, créer des projets,
y lier ou délier des fichiers et y ajouter des notes. Le suivi des impressions
et les connecteurs imprimantes restent à développer.

L'interface permet aussi de supprimer des fichiers, modifier leur état, éditer
ou supprimer des notes et gérer une todo list par projet (ajout, édition,
cases à cocher et suppression). La suppression d'un fichier concerne tous ses
projets et demande confirmation dans l'interface.

## Lancer avec Podman

Prérequis : Podman et un fournisseur Compose (`podman-compose` ou Docker Compose).
Sous Windows/macOS, démarrer la machine Podman avec `podman machine start` si
elle est arrêtée. Depuis la racine :

```powershell
Copy-Item .env.example .env
podman compose up -d --build
```

Sous Linux : `cp .env.example .env`, puis la même commande Podman.

- Application : http://127.0.0.1:8080
- API : http://127.0.0.1:8080/api/v1/health
- Swagger : http://127.0.0.1:8080/docs

`APP_PORT` choisit le port. Pour accéder depuis le réseau local du Dell,
mettre `APP_BIND=0.0.0.0` dans `.env`, puis accéder à `http://IP_DU_DELL:8080`.
L'application n'a pas encore d'authentification ; utiliser un réseau de confiance.

Deux conteneurs : API Python et Nginx servant Angular compilé et relayant `/api`.
Node intervient uniquement pendant la construction. Les migrations s'appliquent
au démarrage de l'API. Les conteneurs tournent sans privilèges root ; les limites
mémoire sont de 512 Mio pour l'API et 128 Mio pour Nginx. La compilation demande
davantage de mémoire : il est possible de construire les images sur un autre PC.

```powershell
podman compose ps
podman compose logs -f
podman compose down
```

Les données sont dans le volume nommé `library-data` (préfixé par le nom du
projet Compose), comprenant SQLite et les fichiers. `down` les conserve ;
`down -v` les supprime. Les données déjà présentes dans `backend/data` ne sont
pas copiées automatiquement dans le volume.

Pour sauvegarder ou transférer ce dossier, arrêter d'abord la pile, copier tout
le volume (base, éventuels fichiers WAL/SHM et dossier `files`), puis redémarrer.
Un disque USB pourra servir à ce stockage lorsque le Dell sera configuré.

## Développement

Voir [le backend](backend/README.md) et [le frontend](frontend/README.md).
Le frontend utilise `/api/v1`, via le proxy Angular en développement et Nginx
dans les conteneurs. Aucun changement d'URL API n'est nécessaire.
