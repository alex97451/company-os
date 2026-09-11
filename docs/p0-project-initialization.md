# P0 — Premier lot d’initialisation autonome

## Résultat livré

Ops sépare désormais la connexion d’un projet en deux décisions compréhensibles :

1. **Analyser le dossier** vérifie le chemin autorisé, son existence et l’accès en écriture, puis détecte les technologies, le gestionnaire de paquets, les commandes, la documentation, l’état Git et une éventuelle initialisation Company OS existante. Cette étape ne crée ni ne remplace aucun fichier.
2. **Confirmer et initialiser** reprend le même projet de manière idempotente, crée uniquement les fichiers Company OS absents et lance la préparation des ressources locales isolées.

La carte du projet expose ensuite sept preuves distinctes : dossier validé, espace analysé, fichiers locaux, base de données, stockage privé, équipe Codex et cockpit. Une ressource n’est marquée comme terminée qu’après le contrôle réel correspondant. En cas d’arrêt, l’étape active devient visible comme échouée et une nouvelle initialisation reprend le même enregistrement et le même manifeste.

## Audit du comportement antérieur

- Le chemin était contrôlé par une liste de racines autorisées et interdites, mais il n’existait pas de prévalidation en lecture seule depuis Ops.
- L’initialiseur détectait seulement quelques scripts `package.json` et créait les fichiers `.company-os` absents.
- La base, le bucket MinIO, les conversations Codex et le cockpit étaient bien préparés par le runtime local, mais Ops n’exposait pas leurs confirmations séparément.
- La présence d’une date `initializedAt` conduisait à afficher « Company OS installé » avant que toutes les ressources aient réellement répondu.
- Les reprises réutilisaient l’identifiant du projet, mais un manifeste existant n’était pas signalé pendant l’analyse et les erreurs restaient peu explicites.

## Frontières et sécurité

- L’analyse et l’initialisation restent limitées aux racines configurées par `COMPANY_PROJECTS_ALLOWED_ROOTS` et excluent les racines interdites.
- Le chemin est contrôlé une première fois avant résolution, puis une seconde fois après `realpath` afin d’empêcher une redirection hors périmètre.
- Les résultats persistés ne contiennent aucun contenu de fichier, nom de fichier Git, secret ou valeur de configuration privée.
- `package.json` et le manifeste existant sont limités en taille et validés avec Zod avant utilisation.
- Une contrainte unique en base et un message stable empêchent de connecter le même dossier sous deux projets différents.
- Aucune action externe, dépense, publication, email ou déploiement n’est déclenché.

## Limites réelles

- Le choix de dossier repose encore sur une saisie de chemin absolu ; le sélecteur natif Windows n’est pas inclus dans ce lot.
- Le premier état des lieux CEO est désormais livré dans le [lot P0 suivant](p0-initial-ceo-review.md) et démarre uniquement après les signaux réels de mise en ligne.
- Un projet initialisé avant ce lot reste compatible, mais sa carte indique qu’il a été initialisé avant le suivi détaillé jusqu’à sa prochaine initialisation.
- La disponibilité complète de PostgreSQL, MinIO, Codex et du cockpit exige toujours que la pile locale soit démarrée. Ops ne les présente comme prêts qu’après leurs signaux réels.

## Prochaine priorité

Poursuivre avec le suivi réel des agents : objectif, étape actuelle, conclusion, livrables et distinction visible entre activité réelle, attente, simulation et échec.
