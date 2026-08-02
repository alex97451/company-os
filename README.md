# Company OS

Company OS est un cockpit local générique pour diriger plusieurs projets avec une équipe interne autonome. Chaque projet connecté reçoit son propre CEO, dix spécialistes, ses conversations Codex persistantes, sa base PostgreSQL, son bucket MinIO, son port et ses livrables.

Company OS reste exclusivement sur la machine locale. Il n’est jamais inclus dans le déploiement d’un SaaS client.

## Démarrage local

Prérequis : Node.js 22+, Docker Desktop démarré et Codex connecté sur la session Windows courante.

```powershell
npm install
npm run ops:setup
.\run-local.ps1
```

Ouvrir `http://localhost:3020/ops`. Le mot de passe propriétaire est stocké dans `.env.local`, ignoré par Git. Pour arrêter le système sans supprimer les données :

```powershell
.\stop-local.ps1
```

Le serveur Next.js fonctionne en mode développement : les changements UI et TypeScript apparaissent automatiquement, sans redémarrer toute la pile.

## Connexion d’un projet

Dans **Système → Projets connectés**, saisir un identifiant, un nom, un type et le chemin absolu d’un dépôt autorisé. L’initialisation est idempotente et ne remplace aucun fichier existant. Elle :

1. ajoute uniquement les fichiers `.company-os` absents dans le projet ;
2. crée une base PostgreSQL et un bucket MinIO dédiés ;
3. crée onze conversations Codex persistantes dédiées au projet ;
4. lance un cockpit et un superviseur sur un port local attribué ;
5. affiche **Ouvrir son cockpit** uniquement après les signaux réels du web et du runtime.

Aucun travail modèle, aucune dépense et aucune action externe ne sont lancés pendant cette préparation. Le propriétaire déclenche ensuite les séquences depuis le cockpit du projet.

## Garde-fous

- `GLOBAL_EXTERNAL_WORK_ENABLED=false` et budget publicitaire nul par défaut.
- Approbation propriétaire obligatoire pour production, publicité, finance et actions externes.
- Aucun secret dans Git, les journaux ou la mémoire des agents.
- `C:\Users\alexe\Documents\GitHub\trading2` est définitivement interdit.
- Aucune donnée simulée n’est affichée comme un état réel ; les doubles déterministes sont réservés aux tests.

Voir [architecture](docs/architecture.md), [exploitation locale](docs/local-runbook.md) et [configuration des fournisseurs](docs/provider-setup.md).
