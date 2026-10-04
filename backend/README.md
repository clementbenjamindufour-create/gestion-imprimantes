# Backend — Gestion des imprimantes 3D

Socle Python 3.12+, FastAPI, SQLAlchemy et SQLite. Le frontend Angular sera
développé séparément. La bibliothèque de fichiers, les projets et les notes
sont disponibles. Les connecteurs imprimantes restent à implémenter.

## Installation (PowerShell)

Depuis la racine du projet :

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Sur Linux, utiliser `.venv/bin/python` à la place de
`.\.venv\Scripts\python.exe`.

- API : http://127.0.0.1:8000/api/v1/health
- Documentation interactive : http://127.0.0.1:8000/docs
- Contrat OpenAPI : http://127.0.0.1:8000/openapi.json

## Configuration

Variables préfixées par `PRINTERS_`, dans l'environnement ou `backend/.env`.
`DATA_DIR` contient SQLite et le dossier `files/` destiné aux fichiers importés.
Les chemins relatifs sont résolus depuis `backend/`, indépendamment du dossier
de lancement. `CORS_ORIGINS` est une liste JSON ; localhost:4200 est autorisé
pour Angular en développement.

Les tables seront gérées exclusivement par Alembic, sans création automatique
au démarrage. La première migration initialise uniquement la chaîne de versions.

```powershell
.\.venv\Scripts\python.exe -m alembic revision --autogenerate -m "description"
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
```

Importer les futurs modèles dans `migrations/env.py` avant une autogénération.
Relire chaque migration avant de l'appliquer.

## Bibliothèque de fichiers et projets

Appliquer les migrations avant de lancer l'API :

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

| Méthode | Route | Entrée | Résultat |
| --- | --- | --- | --- |
| POST | `/api/v1/files` | Multipart : `file`, `state` optionnel | 201, métadonnées du fichier |
| GET | `/api/v1/files/{file_id}/download` | — | 200, fichier en pièce jointe |
| POST | `/api/v1/projects` | JSON : `{"name": "Mon projet"}` | 201, projet |
| PUT | `/api/v1/projects/{project_id}/files/{file_id}` | — | 204 |
| DELETE | `/api/v1/projects/{project_id}/files/{file_id}` | — | 204 |
| POST | `/api/v1/projects/{project_id}/notes` | JSON : `{"content": "Mes notes"}` | 201, note |

Tous les types de fichiers sont acceptés. L'état est du texte libre, commun
aux projets qui utilisent ce fichier ; son absence est représentée par `null`.
Chaque import crée un fichier distinct, même à nom identique. Les fichiers sont
copiés par blocs de 1 Mio, stockés sous un UUID, et téléchargés sous leur nom
d'origine. Aucune déduplication ou analyse du contenu n'est réalisée.

La réponse d'import expose `id`, `filename`, `size_bytes`, `extension`, `kind`,
`is_print_related`, `state` et `created_at` (UTC).
La classification est indicative et fondée sur l'extension, sans distinction
majuscules/minuscules :

- `model` : STL, OBJ, 3MF, AMF, STEP, STP.
- `sliced` : GCODE, GCO, G, GOO, CTB, CBDDLP, PHOTON, PWMO, PWMX, PWS, PWSX.
- `slicer_project` : CURAPROFILE, CURAPROJECT, LYCHEE, LYS.
- `other` : les autres extensions, avec `is_print_related=false`.

Un fichier peut être lié à plusieurs projets. Lier et délier sont idempotents :
répéter l'action renvoie 204. Délier ne supprime ni le fichier ni les autres liens.
Les ressources inexistantes renvoient 404, les UUID et entrées invalides 422.
Les projets doivent avoir un nom non vide (255 caractères maximum), les notes
un contenu non vide. La mise en page et les sauts de ligne des notes sont conservés.

Exemple d'import avec PowerShell :

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/v1/files -F "file=@piece.stl" -F "state=À slicer"
```

Ces routes sont aussi utilisables depuis `/docs`. Pour l'interface Angular :

- `GET /api/v1/files` : liste des fichiers, plus récents en premier.
- `GET /api/v1/projects` : liste des projets, plus récents en premier.
- `GET /api/v1/projects/{project_id}` : projet avec ses fichiers et notes.

Actions supplémentaires :

| Méthode | Route | Entrée |
| --- | --- | --- |
| PATCH | `/api/v1/files/{file_id}` | `{"state": "Prêt"}` ou `{"state": null}` pour effacer |
| DELETE | `/api/v1/files/{file_id}` | Supprime le contenu et tous les liens aux projets |
| PATCH | `/api/v1/projects/{project_id}/notes/{note_id}` | `{"content": "Texte modifié"}` |
| DELETE | `/api/v1/projects/{project_id}/notes/{note_id}` | — |
| POST | `/api/v1/projects/{project_id}/todos` | `{"content": "Vérifier les dimensions"}` |
| PATCH | `/api/v1/projects/{project_id}/todos/{todo_id}` | `{"content": "Autre tâche", "completed": true}` ; champs optionnels |
| DELETE | `/api/v1/projects/{project_id}/todos/{todo_id}` | — |

Le détail d'un projet comprend aussi `todos`. Une tâche contient un texte non
vide et un booléen `completed`, initialement faux. Les notes et tâches ne peuvent
être modifiées ou supprimées que via leur propre projet (404 sinon).
Les notes et tâches sont affichées en texte brut. Les suppressions de ressources
déjà supprimées renvoient 404. La suppression de fichier est globale ; la déliaison
reste disponible pour retirer uniquement le lien à un projet.

La migration `0003` ajoute la table des tâches. Pour le déploiement Podman,
voir le [README principal](../README.md).

## Déploiement prévu

Une instance Uvicorn, sans `--reload`, et les fichiers Angular compilés servis
par un serveur web. Garder SQLite sur un disque local. Les transferts et tâches
persistantes seront ajoutés avec les fonctionnalités métier.
Ce socle n'inclut pas encore d'authentification : démarrage sur 127.0.0.1 par défaut.
