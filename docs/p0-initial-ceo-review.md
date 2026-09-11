# P0 — Premier état des lieux CEO après mise en ligne

## Résultat livré

Après la première mise en ligne réellement vérifiée d’un projet connecté, Company OS déclenche un état des lieux CEO unique et borné. Le CEO reçoit uniquement le diagnostic de découverte déjà validé. Il ne lit pas d’autres fichiers, ne délègue aucun travail et ne déclenche aucune action locale ou externe pendant ce bilan.

Le résultat affiché dans Ops contient :

- une conclusion en français non technique ;
- les limites explicites du diagnostic ;
- exactement trois priorités identifiées `P1`, `P2` et `P3` ;
- pour chaque priorité, le ou les éléments du diagnostic qui la justifient ;
- un à cinq critères d’acceptation vérifiables.

Une réponse qui ne respecte pas ce contrat n’est jamais présentée comme un bilan terminé. Ops affiche alors un état d’erreur, une conclusion compréhensible et la limite rencontrée, sans inventer de priorité.

## Compréhension et hypothèses

- Le bilan est un prolongement du lot d’initialisation, pas un cycle stratégique multi-agents.
- Le registre central conserve l’état du bilan ; la commande et la réponse restent dans la base isolée du projet.
- Un seul bilan initial est attendu par projet et par version du contrat.
- Le volume est faible : une commande CEO et trois priorités au maximum par projet.
- Le délai maximal est de quinze minutes. Un dépassement devient visible et n’entraîne pas une seconde commande automatique.
- Le runtime, PostgreSQL, le stockage et Codex ne sont considérés disponibles qu’après leurs signaux réels respectifs.
- Le propriétaire et l’équipe de maintenance locale restent responsables de corriger une indisponibilité ou une réponse invalide.

## Déclenchement réel

Le runtime suit cet ordre :

1. la base isolée répond et les migrations sont appliquées ;
2. le bucket privé existe et l’accès anonyme est désactivé ;
3. les douze conversations Codex sont créées ou retrouvées ;
4. l’API de santé du cockpit répond ;
5. le superviseur et le worker vidéo restent actifs ;
6. les signaux `supervisor`, `bridge` et `codex` sont tous `connected` et datent de moins de quinze secondes ;
7. le heartbeat `online` du runtime est accepté par le registre ;
8. l’étape cockpit devient terminée, puis le coordinateur du bilan est lancé.

Le bilan ne démarre donc pas sur la seule présence d’une date d’initialisation, d’un processus ou d’un identifiant de conversation.

## Idempotence et reprise

La commande utilise une clé stable dérivée du projet et de la version du bilan. La base isolée impose l’unicité de cette clé.

- Un redémarrage retrouve la commande existante au lieu d’en créer une nouvelle.
- Un coordinateur interrompu reprend les états `pending`, `dispatched` ou `completed` de la même commande.
- Un résultat déjà terminé est renvoyé sans nouvel appel au CEO.
- Une commande expirée, refusée ou à réconcilier devient une erreur visible ; elle n’est pas remplacée silencieusement.
- Un ancien runtime remplacé ne peut pas écraser le résultat terminé d’un runtime plus récent.

Les états persistés et affichés sont `queued`, `running`, `completed` et `error`. Ils proviennent de la commande réelle, jamais d’une temporisation d’interface.

## Frontières et sécurité

- Le prompt ne contient ni chemin absolu, ni nom de branche, ni contenu de fichier, ni secret.
- Seuls les signaux bornés du diagnostic sont transmis : type, technologies, gestionnaire de paquets, noms de scripts, présence de documentation et état Git agrégé.
- Le message interdit explicitement outils, délégation, modification, dépense, déploiement, publicité, publication et contact externe.
- Le contrat entrant et la réponse CEO sont validés avec Zod.
- Le JSON de coordination est remplacé, après validation, par une présentation française lisible dans la conversation CEO.
- Le résultat durable reste dans le manifeste JSON du projet ; aucune migration destructive n’est nécessaire.

## Décisions

| Décision | Alternatives examinées | Motif |
| --- | --- | --- |
| Réutiliser l’outbox CEO existante | Appel Codex direct ; session stratégique complète | Conserve la corrélation, les états réels, la politique de sécurité et la conversation dédiée. |
| Exécuter un coordinateur TypeScript borné après le signal `online` | Ajouter une huitième étape d’initialisation ; lancer depuis l’interface | Le bilan reste distinct des sept preuves techniques et reprend même si Ops n’est pas ouvert. |
| Persister le résultat dans le manifeste du registre | Nouvelle table ; lecture directe de la base projet par le cockpit central | Évite une migration pour un objet unique et maintient l’isolation des bases projet. |
| Exiger exactement trois priorités structurées | Texte CEO libre ; création immédiate de tâches | Rend les propositions traçables sans engager de travail ni action externe. |
| Bloquer les résultats invalides | Extraire approximativement du texte libre | Empêche Ops de présenter une conclusion ou des critères inventés. |

## Vérifications automatisées

Les tests couvrent :

- la construction d’un prompt borné qui n’expose ni chemin ni branche ;
- le refus de moins de trois priorités ou d’un ordre différent de `P1`, `P2`, `P3` ;
- la progression réelle `queued` → `running` → `completed` ;
- la reprise du même identifiant de commande après interruption ;
- l’absence de nouvelle commande pour un bilan déjà terminé ;
- l’erreur explicite face à une réponse CEO invalide ;
- la présentation non technique dans la conversation et dans Ops.

## Limites réelles

- La réussite de bout en bout exige la pile locale réelle : PostgreSQL, MinIO, le runtime du projet et Codex connecté.
- Le bilan repose volontairement sur le diagnostic de découverte ; il ne mesure ni utilisateurs, ni revenus, ni analytics, ni qualité métier non présente dans ce diagnostic.
- Une réponse invalide ou expirée demande aujourd’hui une intervention de maintenance ; les nouvelles tentatives bornées appartiennent au chantier P0 de gestion automatique des blocages.
- Les priorités sont proposées, pas exécutées. Leur transformation en tâches relève du cycle autonome piloté par le CEO.

## Prochaine priorité

Le suivi réel des agents est maintenant décrit dans [le lot P0 correspondant](p0-real-agent-tracking.md). La prochaine priorité est la gestion automatique des blocages : détecter les délais anormaux, tenter uniquement les reprises locales sûres et demander une intervention précise lorsque nécessaire.
