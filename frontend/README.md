# Frontend Angular

Interface en français, adaptée au PC et au téléphone : bibliothèque avec
recherche par nom/état et filtres de type, création de projets, import avec état
libre optionnel, téléchargement, liens/déliaisons et notes de projet.
Un fichier importé depuis un projet peut être lié à celui-ci immédiatement.
Le lien est optionnel ; délier conserve le fichier dans la bibliothèque.
L'état d'un fichier peut être modifié ou effacé. La suppression d'un fichier
le retire de tous les projets. Les notes sont éditables et supprimables.
Chaque projet dispose d'une todo list avec ajout, édition, suivi par cases à
cocher et suppression. Les suppressions demandent une confirmation.

## Développement local

Node 24.15+ et npm. Lancer le backend sur 127.0.0.1:8000, puis :

```powershell
cd frontend
npm ci
npm start
```

Ouvrir http://127.0.0.1:4200. Le proxy transmet `/api` au backend.
`npm run build` génère les fichiers statiques dans `dist/atelier/browser`.
Le fichier `package-lock.json` verrouille les dépendances.

## Podman

Le [compose.yaml](../compose.yaml) construit Angular dans un conteneur Node,
puis copie le résultat dans une image Nginx. Node n'est pas nécessaire sur l'hôte.
Voir le [README principal](../README.md) pour le lancement.

## Tests navigateur

Les tests Playwright utilisent l'API réelle et créent des projets/fichiers de
test. Les lancer sur une pile de test avec son propre volume, pas sur une
bibliothèque personnelle :

```powershell
# Depuis la racine, utiliser un nom de pile et un port distincts.
$env:APP_PORT = "18080"
podman compose -p atelier-test up -d --build
cd frontend
npx playwright install chromium
$env:E2E_BASE_URL = "http://127.0.0.1:18080"
npm run test:e2e
```

Sous Linux, utiliser `APP_PORT=18080 podman compose -p atelier-test up -d --build`
et `E2E_BASE_URL=http://127.0.0.1:18080 npm run test:e2e`.
Les tests couvrent le parcours projet/import/téléchargement/note/déliaison,
la conservation après rechargement, les erreurs serveur et l'affichage mobile.
