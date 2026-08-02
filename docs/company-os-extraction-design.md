# Extraction de Company OS et isolation multi-entreprises

Statut : conception initiale validée, extraction implémentée et vérifiée localement.

> Note d’implémentation : ce document conserve l’historique de la conception. L’architecture effectivement livrée est décrite dans `docs/architecture.md`. Elle renforce l’isolation avec une base PostgreSQL, un bucket, un runtime, un superviseur et onze conversations Codex distincts par projet, au lieu du RLS et du superviseur central envisagés initialement.

## Compréhension verrouillée

- Ops devient un projet local indépendant des SaaS qu'il pilote.
- Chaque projet connecté possède son propre CEO, ses onze spécialistes, ses conversations, ses travaux, ses décisions, ses livrables et sa mémoire.
- Deux projets connectés ne doivent partager aucun contexte métier ou état opérationnel.
- Une seule interface locale permet de sélectionner et piloter les entreprises.
- Les SaaS peuvent être déployés séparément ; aucun code Ops ne doit entrer dans leurs builds publics.
- Aucune dépense, action externe ou secret versionné n'est autorisé par cette extraction.

## Hypothèses et contraintes non fonctionnelles

- Le contrôle central cible un dépôt local indépendant nommé `company-os`.
- PostgreSQL reste local et partagé avec `project_id` et Row-Level Security (RLS). MinIO utilise un bucket et des identifiants restreints distincts par projet ; seuls les composants infrastructure possèdent l'accès administratif.
- Le plafond initial est de 20 projets actifs, 220 agents configurés et 4 tours Codex concurrents au total, avec une limite par projet.
- Une panne d'un runtime projet ne doit pas interrompre les autres projets. Chaque projet possède sa file, ses délais, son circuit breaker et sa limite de concurrence.
- Les requêtes serveur déterminent le projet depuis une route validée et une session autorisée ; elles ne font jamais confiance à un identifiant fourni uniquement par le navigateur.
- Les secrets restent hors Git dans un coffre local chiffré par DPAPI Windows, avec ACL par projet, rotation, révocation et redaction centralisée des journaux, erreurs et sorties d'agents. Les mémoires excluent secrets, données client et contenus bruts.
- La migration suit une stratégie expand/contract. L'ancien cockpit reste compatible pendant l'expansion ; une sauvegarde vérifiée et une migration inverse testée sont requises avant la bascule.

## Alternatives étudiées

1. Superviseur central et isolation logique complète — retenu pour sa simplicité opérationnelle, son coût local faible et sa maintenabilité.
2. Une base PostgreSQL et un superviseur par projet — rejeté car trop coûteux en processus, ports, sauvegardes et mises à jour.
3. Une copie complète d'Ops dans chaque dépôt — rejeté à cause de la duplication et du risque de divergence.

## Architecture cible

`company-os` possède l'interface Ops, l'authentification locale, les migrations opérationnelles, PostgreSQL/MinIO, l'orchestrateur, le superviseur, les conversations Codex et les scripts globaux de démarrage/arrêt.

Chaque SaaS conserve uniquement son produit et un manifeste standard `.company-os` décrivant son identité, son dossier, ses actions connues et ses contraintes. Ce manifeste est déclaratif, versionné et validé par Zod. Il ne contient aucune commande shell libre : les actions `dev`, `verify`, `build` et `stop` sont résolues par un adaptateur utilisant `spawn` sans shell, un exécutable et des arguments autorisés, un environnement minimal, un cwd canonique revérifié avant lancement, des contrôles de reparse points/jonctions/liens, un délai de 30 minutes, une sortie plafonnée à 10 Mo et un registre PID permettant de terminer tout l'arbre du processus.

Les tables métier relatives aux agents, conversations, messages, tâches, exécutions, validations, mémoires, budgets et événements portent un `project_id` obligatoire. Les relations et clés uniques incluent ce périmètre. Chaque transaction métier applique `SET LOCAL app.project_id` et des politiques RLS refusent les lignes des autres projets même lorsqu'une requête oublie son filtre. Les tables globales autorisées sont limitées au registre des projets, à la santé infrastructure et aux versions de migrations.

Chaque projet reçoit un bucket MinIO et un compte de service restreint à ce bucket. L'adaptateur ne reçoit jamais les identifiants administratifs. Une règle statique interdit les imports directs du client MinIO hors du module infrastructure. Les sauvegardes copient réellement les objets et vérifient une restauration cohérente PostgreSQL + MinIO ; un inventaire seul n'est pas une sauvegarde.

Les routes suivent `/ops/projects/:projectId/...`. Le sélecteur de projet reste visible. Le nom et l'état du projet actif sont affichés en permanence. L'identité canonique est un UUID immuable créé par Company OS ; le slug et le nom peuvent changer. Un manifeste copié ou un dossier déplacé déclenche une vérification explicite, jamais un rattachement automatique.

Le cockpit reste consultable si Codex est indisponible. Le CEO doit être provisionné pour envoyer une instruction ; les spécialistes peuvent être réparés progressivement. Une conversation « durable » signifie que son identifiant, sa provenance et son état sont persistés. Si elle disparaît, Company OS affiche `conversation_missing` et exige une reprovision contrôlée sans prétendre restaurer l'historique distant.

Le superviseur central possède des lanes indépendantes par projet. Une lease globale avec fencing token garantit qu'un seul superviseur distribue les travaux ; chaque mutation durable vérifie le token courant. Les effets sont idempotents, les leases expirées passent en réconciliation et aucun état incertain n'est rejoué automatiquement. Une erreur ouvre uniquement le circuit du projet concerné.

## Initialisation autonome

1. Valider le dossier et le manifeste.
2. Créer l'entreprise et son périmètre de données.
3. Créer les onze définitions d'agents de façon idempotente.
4. Créer ou reprendre les conversations manquantes avec une clé de provisionnement stable par projet et agent.
5. Enregistrer les correspondances et signaler les conversations orphelines sans les réutiliser automatiquement.
6. Démarrer le runtime local isolé.
7. Exécuter les contrôles de complétude et activer le cockpit.

Chaque étape possède un identifiant d'opération et un état durable ; `Reprendre` rejoue uniquement les étapes incomplètes. Un échec conserve le projet dans l'état `initialisation_incomplete`, avec une conclusion compréhensible. La consultation reste disponible, mais aucun travail ne part vers un agent non provisionné.

## Migration

1. Créer Company OS sans interrompre le cockpit actuel.
2. Copier puis adapter le code Ops dans le nouveau projet.
3. Déclarer les volumes Docker existants comme volumes externes nommés, vérifier leurs identifiants et effectuer une sauvegarde réelle et restaurable de PostgreSQL et MinIO au même point logique.
4. Ajouter les colonnes de périmètre en mode nullable en conservant la compatibilité de l'ancien cockpit.
5. Classer les données existantes par projet ou comme infrastructure globale. Les données ambiguës restent en quarantaine.
6. Activer les relations composées, contraintes et politiques RLS après vérification du backfill.
7. Provisionner deux projets pilotes comme deux entreprises isolées.
8. Vérifier les deux cockpits, historiques, CEO et équipes.
9. Geler les nouvelles commandes, attendre les états terminaux, transférer la lease de leadership puis basculer le port.
10. Retirer l’ancien code Ops du dépôt client après une période de validation locale et une sauvegarde finale vérifiée.

Les anciennes commandes échouées sont classées uniquement lorsque leur provenance est certaine et ne sont jamais rejouées. La sauvegarde sert à la reprise après sinistre, pas au rollback courant. Après bascule, la base nouvelle reste la source de vérité : une migration inverse préservant toutes les écritures récentes réactive le projet pilote et gèle les autres projets sans supprimer leurs données. RPO cible : zéro écriture validée perdue. RTO cible : 15 minutes. La fenêtre de retour arrière se termine après 24 heures de fonctionnement validé et accord explicite du propriétaire.

Le propriétaire accède à tous les projets. Un opérateur n'accède qu'aux projets de sa table d'appartenance et ne peut effectuer d'action sensible. PostgreSQL utilise un rôle sans `SUPERUSER` ni `BYPASSRLS`; toutes les tables métier appliquent `ENABLE ROW LEVEL SECURITY` puis `FORCE ROW LEVEL SECURITY`. Une variable projet absente, vide ou invalide refuse la transaction. Le pool n'exécute les dépôts métier que dans une transaction ayant fixé le projet et l'appartenance de session.

Ops écoute sur loopback par défaut. L'accès LAN est optionnel et exige HTTPS local, cookies `Secure`, `HttpOnly` et `SameSite=Strict`, CSRF, validation exacte de l'origine, expiration et révocation de session, limitation des tentatives et dérivation robuste des mots de passe. Aucun accès HTTP LAN n'est considéré sûr.

La planification applique un round-robin pondéré par projet, deux tours maximum par projet et quatre au total, une file maximale de 100 travaux par projet et un délai d'attente visible. Les événements expirent après 30 jours et les mémoires temporaires après 90 jours ; décisions et livrables restent jusqu'à suppression explicite. La suppression d'un projet impose sept jours de quarantaine puis purge son périmètre PostgreSQL, son bucket, ses secrets et ses correspondances de conversations, avec tests négatifs inter-projets.

## Contrat d'expérience propriétaire

La page globale « Mes entreprises » affiche uniquement les entreprises et la santé de l'infrastructure commune. L'ouverture d'une entreprise affiche un bandeau permanent « Vous pilotez : <nom> » avec une identité visuelle propre. Le CEO, les agents, travaux, mémoire, décisions, livrables et statistiques changent ensemble ; aucun module projet ne reste sur l'entreprise précédente.

Un projet possède un état principal unique : `Prêt`, `Préparation en cours`, `Action nécessaire`, `En pause` ou `Hors ligne`. La disponibilité de l'équipe est affichée séparément. Pour le CEO, les libellés visibles sont : `À configurer`, `Disponible`, `Instruction reçue`, `Travail en cours`, `Terminé`, `Quota atteint` ou `Problème technique`. Un CEO configuré n'est jamais présenté comme disponible sans contrôle réel du service et du quota.

Chaque incident visible présente quatre informations : ce qui fonctionne déjà, ce qui bloque, la conséquence concrète et la prochaine action. Le bouton `Reprendre` affiche avant exécution les seules étapes qui seront retentées et ne réexécute jamais une étape terminée. Les codes internes (`RLS`, `lease`, `conversation_missing`, etc.) restent dans un volet technique secondaire.

L'accès LAN possède un assistant de configuration qui fournit l'adresse HTTPS correcte et explique le certificat local. Une ancienne adresse HTTP affiche une page locale d'orientation ; elle ne produit jamais une erreur CORS brute ni un bouton mystérieusement désactivé.

L'expiration des événements et mémoires temporaires ne supprime pas les conclusions, décisions ou livrables. L'interface explique ces catégories. Lors d'une suppression, le projet passe pendant sept jours dans « Corbeille — récupérable jusqu'au <date> », puis une confirmation propriétaire distincte déclenche la suppression définitive et énumère les données concernées.

## Critères d'acceptation

- Deux projets pilotes ont des cockpits entièrement distincts.
- Aucune requête ne peut lire ou modifier les données d'un autre projet.
- Chaque projet possède onze conversations Codex propres.
- Un seul superviseur central dessert plusieurs entreprises sans mélange de contexte.
- Aucun code Ops n'est inclus dans les builds SaaS.
- `run-local.ps1` et `stop-local.ps1` pilotent toute l'infrastructure locale.
- Les échecs d'initialisation et de fournisseur sont expliqués en langage non technique.
- Le projet actif est visible sur chaque vue et tous les modules partagent exactement le même contexte.
- Les états projet et CEO suivent le vocabulaire propriétaire défini, avec une prochaine action explicite.
- Les conclusions, décisions et livrables restent visibles après expiration de la télémétrie temporaire.
- Les tests de migration, isolation, reprise, sécurité, responsive et retour arrière passent.

## Journal de décision

| Décision | Alternatives | Motif | Objections | Résolution |
|---|---|---|---|---|
| Extraire Ops dans `company-os` | Ops dans le premier produit | Découpler le système d'exploitation des projets clients | Volumes, secrets et frontière d'exécution ambigus | Volumes externes vérifiés, secrets typés par périmètre et manifeste sans commande shell libre |
| Superviseur central | Un superviseur par projet | Réduire processus et maintenance | Point de panne, double distribution, reprise incertaine | Lanes et circuits par projet, fencing vérifié à chaque mutation, effets idempotents et réconciliation sans rejeu automatique |
| PostgreSQL partagé avec `project_id` | Une base par projet | Exploitation locale simple | RLS contournable par rôle ou contexte absent | Rôle non privilégié, `FORCE RLS`, transaction obligatoire et refus sans contexte valide |
| Un bucket MinIO par projet | Préfixes dans un bucket partagé | Imposer l'isolation dans MinIO | Adaptateur seul contournable | Comptes de service restreints, import direct interdit et sauvegarde réelle testée |
| Conversations Codex distinctes | Conversations partagées | Éviter toute contamination de contexte | Provisionnement total bloquant et durabilité imprécise | Cockpit consultable hors ligne, activation agent par agent et état `conversation_missing` explicite |
| Migration progressive réversible | Bascule immédiate | Protéger données et disponibilité locale | Ancien schéma incompatible, double exécution et rollback incomplet | Expand/contract, quarantaine, gel des commandes, transfert de lease, sauvegarde restaurable et migration inverse |
| UUID projet canonique | Slug ou chemin comme identité | Autoriser renommage et déplacement sans collision | Manifeste copié ou dossier déplacé | Vérification explicite ; aucun rattachement automatique d'historique |
| Initialisation idempotente | Relance complète | Éviter doublons et ressources orphelines | Reprise après échec partiel | Étapes persistées avec clés stables et reprise ciblée |
| Accès LAN HTTPS optionnel | HTTP LAN | Protéger sessions et mots de passe | Interception sur réseau local | Loopback par défaut, TLS requis sur LAN et contrôles session/CSRF/origine |
| RPO 0 / RTO 15 min | Restauration de sauvegarde après bascule | Préserver les nouvelles écritures | Sauvegarde initiale obsolète après bascule | Migration inverse sur la base courante ; sauvegarde réservée au sinistre |
| État propriétaire unique | Exposer les états techniques | Permettre un pilotage non technique | Projet affiché prêt alors que le CEO est indisponible | État principal projet séparé de la disponibilité réelle de l'équipe et du fournisseur |
| Contexte visuel verrouillé | Simple filtre de requête | Éviter d'agir sur la mauvaise entreprise | Modules pouvant sembler globaux ou décalés | Bandeau permanent et changement atomique de tous les modules projet |
| Reprise expliquée | Bouton générique `Reprendre` | Rendre les erreurs actionnables | Rejeu incompréhensible ou anxiogène | Résumé en quatre points et aperçu des seules étapes retentées |

## Disposition de la revue

**APPROVED** — Les objections concernant le rollback, RLS, MinIO, le superviseur, le provisionnement, la sécurité Windows/LAN, la capacité et l'expérience propriétaire ont toutes été acceptées et intégrées. Aucune objection n'a été rejetée et aucun point bloquant de conception ne reste ouvert. L'implémentation et les tests d'acceptation restent à réaliser.
