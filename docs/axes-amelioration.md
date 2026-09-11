# Axes d’amélioration de Company OS

## Objectif

Faire de Company OS un système local capable d’initialiser, piloter et faire progresser plusieurs entreprises numériques de manière autonome, tout en laissant au propriétaire un contrôle clair sur les décisions, les dépenses et les actions externes.

Le produit doit rester compréhensible par une personne non technique. L’autonomie ne doit pas seulement être annoncée : elle doit être observable, contrôlable et capable de reprendre proprement après un échec.

## Principes directeurs

- Une entreprise et ses données restent totalement isolées des autres projets.
- Le propriétaire décide quand lancer, suspendre ou arrêter un cycle autonome.
- Les actions locales sûres peuvent être automatisées.
- Toute dépense, publication, communication externe ou mise en production reste soumise aux règles d’autorisation du propriétaire.
- Chaque travail doit produire une conclusion compréhensible et, lorsque cela s’applique, un livrable consultable.
- Les messages affichés dans Ops doivent expliquer les conséquences métier, et non exposer uniquement des événements techniques.
- Les secrets restent hors du dépôt et sont conservés de manière sécurisée et persistante.

## P0 — Rendre le fonctionnement fiable et compréhensible

### 1. Initialisation autonome d’un projet

**But :** permettre au propriétaire de connecter un dépôt et d’obtenir une entreprise opérationnelle sans configuration technique manuelle.

**Livrables :**

- sélection ou saisie du dossier du projet ;
- validation du chemin et des permissions avant toute modification ;
- détection de la technologie, des scripts, de la documentation et de l’état Git ;
- création automatique du cockpit, de la base, du stockage, de la mémoire et des conversations Codex ;
- constitution d’un premier état des lieux par le CEO ;
- proposition des premières priorités et tâches ;
- progression détaillée de l’initialisation avec messages d’erreur compréhensibles ;
- reprise possible après une interruption sans dupliquer l’entreprise.

**Terminé lorsque :** un nouveau projet peut être connecté depuis Ops, redémarré, puis retrouvé avec toutes ses données et son équipe isolées.

### 2. Suivi réel des agents

**But :** montrer clairement qui travaille, sur quoi, pourquoi et avec quel résultat.

**Livrables :**

- mise en évidence des agents actifs, en attente, bloqués et terminés ;
- vue détaillée d’un agent avec objectif, étape actuelle, décisions et livrables ;
- événements reformulés en français non technique ;
- progression actualisée automatiquement ;
- conclusion obligatoire pour chaque travail terminé ;
- distinction visible entre activité réelle, attente, simulation et échec.

**Terminé lorsque :** le propriétaire comprend l’état d’un travail sans consulter les journaux techniques.

**État local :** livré dans [P0 — Suivi réel des agents](p0-real-agent-tracking.md). Ops projette les états et résultats durables en informations propriétaire bornées, distingue explicitement attente, activité réelle enregistrée, simulation et échec, et conserve les détails techniques hors de la vue principale.

### 3. Gestion automatique des blocages

**But :** éviter qu’une tâche reste silencieusement bloquée.

**Livrables :**

- détection des délais anormaux et des erreurs de runtime ;
- nouvelle tentative limitée pour les opérations locales sûres ;
- diagnostic lisible avec cause probable et action recommandée ;
- possibilité de réaffecter ou relancer une tâche ;
- demande d’autorisation explicite si la résolution exige une action sensible ;
- conservation de l’historique des tentatives sans exposer de secret.

**Terminé lorsque :** toute tâche bloquée conduit à une reprise automatique sûre ou à une demande précise adressée au propriétaire.

### 4. Isolation complète des entreprises

**But :** garantir qu’aucune donnée ni activité d’un projet n’apparaisse dans un autre.

**Livrables :**

- base, mémoire, conversations, livrables et runtime dédiés ;
- filtrage systématique par entreprise dans toutes les vues et API ;
- navigation claire entre les projets ;
- démarrage, arrêt, sauvegarde et archivage indépendants ;
- tests automatisés contre les fuites entre projets.

**Terminé lorsque :** deux projets peuvent fonctionner simultanément sans partage involontaire d’état, de conversation ou de livrable.

## P1 — Améliorer le pilotage de l’entreprise

### 5. Cycle autonome piloté par le CEO

**But :** permettre à l’entreprise de faire régulièrement le point et de décider des travaux utiles.

**Déroulement cible :**

1. Le CEO analyse la situation, les objectifs, les travaux précédents et les indicateurs disponibles.
2. Les spécialistes proposent leurs constats, risques et opportunités.
3. Les agents confrontent leurs recommandations et identifient les dépendances.
4. Le CEO sélectionne une stratégie réaliste et priorisée.
5. Les tâches reçoivent un responsable, un vérificateur, un résultat attendu et des critères d’acceptation.
6. Le propriétaire consulte le plan et lance le cycle lorsqu’il le souhaite.
7. Le CEO consolide les conclusions et propose la suite.

**Terminé lorsque :** un cycle produit une stratégie, des tâches traçables, des livrables et un bilan final sans intervention technique manuelle.

### 6. Cockpit plus simple

**But :** présenter les informations importantes sans imposer un long défilement.

**Accueil recommandé :**

- situation générale de l’entreprise ;
- trois priorités actuelles ;
- agents actifs et tâches bloquées ;
- décisions attendues du propriétaire ;
- conversation avec le CEO ;
- derniers livrables ;
- bouton de lancement du pilotage autonome.

La santé technique, les fournisseurs, les journaux et les réglages avancés doivent rester accessibles dans des onglets dédiés.

**Terminé lorsque :** les informations essentielles tiennent dans une vue principale compacte sur ordinateur et restent utilisables sur mobile.

### 7. Bibliothèque de livrables

**But :** centraliser tout ce que l’entreprise produit.

**Livrables :**

- stratégies, rapports, audits, contenus, images, vidéos, documents et décisions ;
- recherche et filtres par projet, agent, type, date et statut ;
- version, auteur, vérificateur et historique ;
- aperçu intégré pour les formats compatibles ;
- actions pour télécharger, approuver, refuser ou demander une correction ;
- lien direct entre une tâche, sa conclusion et ses fichiers.

**Terminé lorsque :** tout résultat annoncé comme terminé est immédiatement consultable depuis Ops.

### 8. Configuration des fournisseurs

**But :** connecter les services nécessaires sans modifier manuellement des fichiers de configuration.

**Livrables :**

- page non technique pour l’IA, l’image, la vidéo, l’analytics et les futures plateformes ;
- OAuth persistant lorsque le fournisseur le permet ;
- stockage local chiffré des identifiants ;
- test de connexion et affichage de la dernière vérification ;
- permissions minimales et révocation simple ;
- séparation entre fournisseur configuré, activé, indisponible et simulé.

**Terminé lorsque :** une intégration peut être connectée, testée, utilisée puis révoquée depuis Ops sans exposer ses secrets.

## P2 — Développer les capacités de croissance

### 9. Studio marketing opérationnel

**But :** préparer une stratégie et des contenus adaptés à chaque canal.

**Livrables :**

- calendrier éditorial ;
- génération de textes, images et vidéos verticales ;
- prévisualisation TikTok et Instagram dans Ops ;
- variantes, sous-titres, miniature et contrôles qualité ;
- mémoire des publications, commentaires et réponses ;
- propositions de réponses contextualisées ;
- file de validation avant toute publication externe ;
- mesure des résultats lorsque les connecteurs réels sont autorisés.

**Terminé lorsque :** une campagne complète peut être préparée et validée localement, puis publiée uniquement selon les autorisations du propriétaire.

### 10. Sécurité, sauvegarde et reprise

**But :** protéger les entreprises locales et permettre une restauration fiable.

**Livrables :**

- sauvegarde chiffrée des bases et mémoires ;
- restauration testée par projet ;
- rotation et révocation des identifiants ;
- journal d’audit des actions sensibles ;
- rôles propriétaire et opérateur ;
- expiration des sessions et protection du réseau local ;
- analyse des dépendances et procédure de mise à jour.

**Terminé lorsque :** un projet peut être restauré sur une installation propre sans perdre ses décisions, tâches ni livrables.

### 11. Ouverture publique du projet

**But :** rendre Company OS installable, compréhensible et crédible pour un nouvel utilisateur.

**Livrables :**

- guide d’installation rapide reproductible ;
- démonstration vidéo et captures d’écran ;
- cas d’usage Wedding Quote Check de bout en bout ;
- documentation d’architecture, sécurité et dépannage ;
- licence non commerciale clairement expliquée ;
- modèle de contribution et feuille de route publique ;
- vérification sur une machine propre.

**Terminé lorsque :** une personne extérieure peut installer la démonstration locale et comprendre la valeur du produit sans assistance directe.

## Ordre de réalisation recommandé

1. Initialisation autonome d’un projet.
2. Suivi réel des agents.
3. Gestion automatique des blocages.
4. Isolation complète des entreprises.
5. Cycle autonome piloté par le CEO.
6. Bibliothèque de livrables.
7. Simplification du cockpit.
8. Configuration sécurisée des fournisseurs.
9. Studio marketing opérationnel.
10. Sauvegarde, restauration et sécurité renforcée.
11. Documentation et démonstration publiques.

## Indicateurs de réussite

- Temps nécessaire pour connecter un nouveau projet.
- Pourcentage d’initialisations terminées sans intervention technique.
- Pourcentage de tâches disposant d’une conclusion et d’un livrable.
- Nombre de blocages détectés et résolus automatiquement.
- Temps moyen entre une erreur et une explication utile au propriétaire.
- Nombre de fuites de données entre projets : objectif zéro.
- Pourcentage d’actions externes correctement soumises à autorisation : objectif 100 %.
- Taux de restauration réussie d’un projet sauvegardé : objectif 100 %.

## Prochaine étape concrète

Transformer les quatre chantiers P0 en lots de développement courts et démontrables. Chaque lot doit comporter un comportement observable dans Ops, un test de non-régression et une conclusion compréhensible par le propriétaire.
