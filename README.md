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

## Déployer depuis Windows vers le serveur

Le script `deploy.ps1` utilise `server.local` par défaut. Prérequis : OpenSSH
et une machine Podman démarrée sur le PC ; SSH, Podman et un fournisseur Compose
sur le serveur Linux x86_64. Le compte SSH doit être celui qui possède
les conteneurs et le volume Podman existants (déploiement sans `sudo`).

Première connexion (compte `user` sur `server.local` par défaut) :

```powershell
.\deploy.ps1 -SetupSsh
```

Cette commande crée si nécessaire une clé Ed25519 dédiée sans phrase secrète
dans `.deploy/id_ed25519`, puis ajoute sa clé publique à `authorized_keys`.
Il faut confirmer l’empreinte du serveur après vérification et saisir son mot
de passe une fois. La clé privée reste sur le PC ; `.deploy/` est exclu de Git.
Protéger ce dossier comme un mot de passe. Une clé existante n’est pas remplacée.
Le mode `-SetupSsh` configure uniquement SSH, sans déployer.
Si Windows bloque l’exécution des scripts, utiliser pour cette invocation
`powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1 -SetupSsh`
(et retirer `-SetupSsh` pour le déploiement), sans modifier la politique globale.

Pour les mises à jour :

```powershell
podman machine start
.\deploy.ps1
# Autre serveur ou ports :
.\deploy.ps1 -User user -Server 192.168.1.50 -SshPort 22 -AppPort 8080
```

Le paramètre `-User` permet de remplacer le compte `user` utilisé par défaut.
`-IdentityFile` permet de choisir une autre clé, `-RemoteDirectory` un dossier
relatif au dossier de connexion SSH (défaut : `gestion-imprimantes`).

Le script construit les images backend et frontend pour Linux amd64 sur le PC,
les exporte puis les transfère par SCP. Le PC a besoin d’Internet pour les images
de base et les dépendances ; le serveur n’a pas besoin d’Internet pour ce
déploiement, une fois les prérequis installés. Les erreurs de construction
interrompent le déploiement avant de modifier l’application sur le serveur.

Sur le serveur, le script charge les images, arrête brièvement les services,
sauvegarde tout le volume `gestion-imprimantes_library-data`, puis lance la
nouvelle version et vérifie `/api/v1/health` via Nginx depuis le conteneur frontend,
sans nécessiter `curl` sur le serveur. Le volume existant est conservé.
Les migrations sont exécutées au démarrage du backend. L’application est ensuite
accessible sur `http://server.local:8080` et écoute sur toutes les interfaces du
serveur : utiliser le réseau local de confiance, l’application n’ayant pas encore
d’authentification.

Les versions sont dans `~/gestion-imprimantes/releases/`, les sauvegardes dans
`~/gestion-imprimantes/backups/`, et `current-release` indique le dernier
déploiement validé. Les archives locales restent dans `.deploy/releases/`.
Aucun nettoyage automatique ne supprime les sauvegardes ou les anciennes images :
surveiller leur taille. Ne pas lancer simultanément une mise à jour manuelle et
ce script. Un verrou bloque les déploiements concurrents par ce script.

En cas d’échec après le démarrage, consulter les logs depuis le dossier de la
version concernée : `podman compose --env-file .env -f compose.yaml logs`.
Le script ne restaure pas automatiquement une ancienne version : une migration
peut rendre nécessaire la restauration des données en plus des images.
La sauvegarde TAR contient le dossier `data/`, avec SQLite et les fichiers ;
une restauration s’effectue services arrêtés dans le même volume Podman, en
conservant les propriétaires des fichiers. Les archives ne sont pas chiffrées.

## Développement

La barre latérale affiche l’espace disponible et la capacité totale du disque
contenant les fichiers, via `GET /api/v1/storage`. Ces informations sont mises
à jour avec « Actualiser », après un import ou une suppression. L’occupation
concerne tout le disque, y compris les données des autres applications. Avec
Podman, la mesure concerne le système de fichiers hébergeant le volume de données
(dans la machine virtuelle sous Windows/macOS).

Voir [le backend](backend/README.md) et [le frontend](frontend/README.md).
Le frontend utilise `/api/v1`, via le proxy Angular en développement et Nginx
dans les conteneurs. Aucun changement d'URL API n'est nécessaire.
