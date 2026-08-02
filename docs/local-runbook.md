# Exploitation locale

## Première installation

1. Démarrer Docker Desktop.
2. Exécuter `npm install` puis `npm run ops:setup`.
3. Vérifier dans `.env.local`, sans copier les valeurs, que `OPS_CODEX_MODE=app-server-stdio` et `GLOBAL_EXTERNAL_WORK_ENABLED=false`.
4. Exécuter `run-local.ps1`.
5. Ouvrir `http://localhost:3020/ops`.

## Usage quotidien

- Démarrage complet : `run-local.ps1`.
- Arrêt complet : `stop-local.ps1`.
- Les volumes PostgreSQL et MinIO sont conservés à l’arrêt.
- Les modifications du cockpit sont rechargées automatiquement.
- Un projet affiché **En ligne** possède un web joignable et un parent de runtime vivant ; la page Santé confirme séparément le superviseur et Codex.

## Incidents

- **Base hors ligne** : vérifier Docker Desktop puis relancer `run-local.ps1`.
- **Codex hors ligne** : vérifier la connexion de l’application Codex et les journaux dans `work/`.
- **Projet en erreur** : le code lisible apparaît sur sa carte ; corriger la cause puis cliquer sur **Redémarrer**.
- **Port occupé** : arrêter le processus étranger ou retirer l’attribution dans le registre avant de relancer. Company OS ne tue jamais un processus non suivi.

Ne jamais supprimer les volumes, bases ou fichiers `work/projects` sans sauvegarde et demande explicite du propriétaire.
