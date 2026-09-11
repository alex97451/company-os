# P0 — Suivi réel des agents

## Résultat attendu

La vue Équipe d’Ops doit permettre au propriétaire de comprendre un travail sans ouvrir les journaux techniques. Pour chaque agent, elle distingue explicitement une attente, une exécution réelle enregistrée, une simulation et un échec. La fiche détaillée présente l’objectif, l’étape actuelle, les décisions importantes, la conclusion et les livrables ou preuves vérifiés.

Le lot complète la projection d’activité existante. Il ne crée pas un second moteur de suivi et ne déduit pas une activité à partir d’une animation ou d’un délai d’interface.

## Compréhension et hypothèses

- PostgreSQL et les événements corrélés au travail restent la source d’autorité.
- Une tâche en file ou en transmission est en attente ; elle n’est pas annoncée comme réellement commencée.
- Une exécution réelle exige un événement de démarrage ou de fin enregistré. Le transport de démonstration reste signalé comme simulation.
- Un état `failed`, `blocked`, `orphaned` ou `reconciliation_required` est présenté comme un échec ou un résultat à confirmer, jamais comme une réussite.
- Une tâche terminée doit posséder une conclusion structurée. Une conclusion historique absente reste visible comme une limite au lieu d’être inventée.
- Les éléments affichés comme livrables sont les preuves déclarées par le résultat structuré et contrôlées par la politique propriétaire. Ils ne constituent pas encore une bibliothèque de fichiers téléchargeables.
- Le volume cible reste borné à douze agents, vingt événements récents par fiche, douze preuves par résultat et deux cents travaux dans l’instantané Ops.
- L’actualisation existante est conservée : événement local en direct, resynchronisation après 250 ms et contrôle périodique toutes les quinze secondes.

## Contrat propriétaire

La projection d’un agent expose uniquement :

- l’identifiant du travail et du run corrélés ;
- le titre et le résultat attendu ;
- la phase et une étape actuelle reformulée en français ;
- la nature de l’activité : `waiting`, `real`, `simulation` ou `failure` ;
- la conclusion propriétaire, si elle existe ;
- au plus douze preuves ou livrables vérifiés ;
- les décisions importantes reformulées : choix des ressources, autorisation du propriétaire et vérification indépendante ;
- au plus vingt événements nettoyés.

Les identifiants de conversation, prompts, sorties brutes, diagnostics internes, raisonnements, secrets et données client ne traversent pas ce contrat.

## Sécurité et échec fermé

- Le résultat spécialiste reste validé avec Zod avant toute confirmation.
- La conclusion et chaque preuve passent la politique de contenu propriétaire.
- Une preuve contenant un secret, une adresse email ou un contenu commercial sensible place le run en état à réconcilier ; elle n’est ni confirmée ni affichée.
- Les champs arbitraires des événements ne sont jamais recopiés dans l’API cliente.
- Le mode démonstration est déterminé par le transport ou le marqueur durable du résultat, pas par le texte de l’agent.
- Aucun déploiement, paiement, publicité, publication, email ou autre action externe n’est ajouté par ce lot.

## Approches examinées

| Approche | Décision | Motif |
| --- | --- | --- |
| Enrichir la projection sûre des événements existants | Retenue | Réutilise la corrélation et la reprise déjà fiables, sans dupliquer l’état. |
| Ajouter une table générique de livrables | Reportée | Utile pour une future bibliothèque durable, mais excessive pour afficher les preuves structurées déjà disponibles. |
| Calculer les états uniquement dans l’interface | Écartée | Risque de présenter une animation ou un délai comme un état réel et disperse les règles métier. |

## Critères d’acceptation

- Les cartes distinguent agents actifs, en attente, en échec et récemment terminés.
- La fiche d’un agent montre une nature d’activité explicite, l’objectif et l’étape actuelle.
- Une simulation ne porte jamais le libellé d’activité réelle.
- Un travail terminé affiche sa conclusion ; son absence historique est signalée comme limite.
- Les décisions et preuves autorisées sont lisibles sans ouvrir les détails techniques.
- Une preuve sensible est refusée avant création d’un événement de réussite.
- Les événements restent en français non technique et l’interface se met à jour automatiquement.
- Les contrats Zod, tests unitaires, vérifications responsive et build restent valides.

## Limites

- Ce lot ne détecte pas encore automatiquement un heartbeat anormalement ancien et ne relance pas un run. Ce comportement appartient au chantier P0 suivant sur les blocages.
- Une preuve est une déclaration structurée et contrôlée, pas une attestation cryptographique. Les livrables des sessions stratégiques conservent leur stockage spécialisé.
- La disponibilité courante du superviseur, du pont et de Codex reste présentée séparément dans Santé ; une exécution historique réelle ne prétend pas que ces composants sont encore connectés.

## Prochaine priorité

Mettre en place la gestion automatique des blocages : détecter les délais anormaux, tenter uniquement les reprises locales sûres et formuler une demande précise lorsque l’intervention du propriétaire est indispensable.
