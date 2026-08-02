# Configuration des fournisseurs

La configuration se fait dans le cockpit local, section **Système → Connexions externes**. Les identifiants sont chiffrés avec la clé persistante `OPS_CONNECTOR_ENCRYPTION_KEY` conservée dans `.env.local` et ne sont jamais affichés dans les journaux.

## Principes

- Les fournisseurs réels restent déconnectés tant que leurs identifiants ne sont pas saisis.
- Une connexion n’autorise pas automatiquement son utilisation : les politiques et approbations restent applicables.
- OAuth utilise l’URL de rappel affichée par le cockpit actuellement ouvert. Cette URL peut différer entre le cockpit central et un projet.
- Ne jamais copier un secret dans un message au CEO, un livrable ou un fichier versionné.

## Procédure

1. Ouvrir le cockpit du projet concerné.
2. Aller dans **Système → Connexions externes**.
3. Sélectionner le fournisseur et saisir uniquement les champs demandés.
4. Pour OAuth, déclarer chez le fournisseur l’URL de rappel affichée, puis terminer l’autorisation dans le navigateur.
5. Utiliser **Tester la connexion**. Le statut **Connecté** doit provenir d’un test réel.
6. Conserver le travail externe désactivé jusqu’à l’approbation explicite du propriétaire.

Les sessions OAuth et jetons renouvelables sont persistants dans la base dédiée du projet. Un changement de clé de chiffrement rend les identifiants existants illisibles ; sauvegarder la clé avant toute rotation.
