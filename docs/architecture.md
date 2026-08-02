# Architecture locale de Company OS

## Séparation

Le contrôle central vit dans `C:\Users\alexe\Documents\Codex\company-os`. Les projets clients restent dans leurs propres dépôts et seuls les SaaS clients peuvent être déployés.

Le registre central utilise la base `company_os`. Chaque projet reçoit une base distincte `company_os_<identifiant>`, un bucket `company-os-<identifiant>`, un port entre 3200 et 3399 et un fichier local ignoré contenant ses onze identifiants de conversations. Cette séparation par base remplace le RLS envisagé dans la première conception : elle réduit les risques de requête non filtrée et permet sauvegarde, restauration et suppression projet par projet.

## Processus

- Web central : Next.js en développement sur `127.0.0.1:3020`.
- Infrastructure : PostgreSQL sur `127.0.0.1:5434`, MinIO sur `127.0.0.1:9002`, console MinIO sur `127.0.0.1:9003`.
- Superviseur central : processus TypeScript séparé.
- Runtime projet : processus parent suivi dans le registre ; il gère le web et le superviseur dédiés.
- Codex : `app-server-stdio` réutilise la session Codex Windows authentifiée, sans clé API dans le dépôt.

## Autorité et sécurité

Les projets sont limités aux racines explicitement autorisées. Les fichiers existants ne sont jamais remplacés lors de l’initialisation. Les mutations sensibles passent par les approbations du propriétaire. Les conversations Codex n’obtiennent que le dépôt du projet comme racine d’exécution.

Le cockpit est local et marqué `noindex`. Le mode LAN est facultatif, limité au réseau privé et ne doit jamais être publié ou transféré par le routeur.
