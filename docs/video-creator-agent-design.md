# Agent vidéo viral et Studio vidéo local

## Résumé de la décision

Company OS ajoute un douzième agent interne, `video_creator`, dédié à la création à la demande de vidéos verticales faceless pour TikTok et Instagram Reels. Cet agent utilise une conversation Codex persistante propre à chaque projet, consulte les agents Croissance, Contenu et Design lorsque le travail l'exige, puis produit un brief structuré que le moteur Remotion intégré transforme en vrai fichier MP4.

Le propriétaire déclenche chaque production manuellement depuis Ops. Company OS ne publie jamais automatiquement, ne contacte aucun réseau social et ne dépense rien. La promesse porte sur un potentiel viral estimé par des critères explicables, jamais sur une viralité garantie.

## Expérience propriétaire

Un onglet **Studio vidéo** est disponible dans le cockpit de chaque projet. Il contient :

- un formulaire simple : sujet, objectif, langue, durée et modèle ;
- les trois accroches proposées et l'accroche retenue ;
- le storyboard et les textes affichés ;
- la progression réelle de l'écriture, de la voix, du rendu et du contrôle qualité ;
- un lecteur vertical pour regarder le MP4 final ;
- le score heuristique, les contrôles qualité, la légende et les hashtags ;
- le téléchargement du MP4, de la miniature et des éléments éditoriaux ;
- l'historique isolé du projet, avec relance ou rejet explicite.

## Architecture

1. L'API Ops valide la demande avec Zod et crée un travail vidéo en base PostgreSQL du projet.
2. Le worker vidéo local prend un seul travail à la fois pour ce projet et enregistre chaque changement d'étape.
3. L'agent Codex `video_creator` reçoit une tâche bornée. Son résultat attendu est un `video-brief.json` conforme au schéma versionné, avec scènes, voix, textes, rythme, transitions, sources et droits déclarés.
4. Si le résultat Codex n'est pas exploitable, le worker utilise un brief déterministe fondé uniquement sur la demande validée ; il ne prétend pas que Codex a terminé le travail.
5. Une voix locale Windows est synthétisée. Aucun texte n'est envoyé à un service vocal externe.
6. Remotion rend une composition 1080 × 1920, 30 images/seconde, entre 15 et 60 secondes. Les premiers modèles sont `problem_reveal_solution`, `quick_list` et `before_after`.
7. Le MP4 et la miniature sont stockés dans le stockage privé isolé du projet. La base ne conserve que les métadonnées et les clés d'objet.
8. L'API média authentifiée diffuse les fichiers au lecteur Ops ; aucun lien public n'est créé.

## Données et états

Un travail passe par les états réels suivants : `queued`, `briefing`, `voice`, `rendering`, `quality_check`, `completed`, `failed`, `cancelled`. La progression affichée provient de la base et non d'une animation simulée.

Le brief conserve seulement les informations opérationnelles nécessaires à la vidéo. Les journaux n'enregistrent ni secrets, ni contenu client brut, ni texte complet de la narration. Les fichiers restent séparés par projet. Une seule production peut être active par projet. Deux reprises ciblées au maximum sont autorisées avant un échec explicite.

## Contrôle qualité

Le worker vérifie avant de déclarer une vidéo terminée :

- présence et lisibilité du MP4 ;
- dimensions verticales, durée, codec et piste audio ;
- zones sûres TikTok/Reels et taille minimale des textes ;
- présence des sous-titres et absence d'élément manquant ;
- traçabilité des affirmations et droits déclarés pour chaque média ou musique ;
- légende et hashtags cohérents avec le sujet et la langue.

Une erreur de rendu, de voix ou de stockage produit un code compréhensible dans Ops. Un fichier partiel n'est jamais présenté comme terminé.

## Sécurité et limites

- Exécution locale uniquement ; aucune publication sociale automatique.
- Zéro budget publicitaire et aucun connecteur externe requis pour produire une vidéo.
- Les médias importés doivent appartenir au propriétaire ou disposer d'une licence déclarée.
- Les changements de modèle Remotion sont des changements de code revus par Développement et Qualité ; l'agent remplit des modèles versionnés mais ne génère pas du code exécutable librement pour chaque vidéo.
- La licence Remotion doit être réévaluée avant tout usage commercial ou automatisé à plus grande échelle. Aucune licence payante n'est souscrite par cette implémentation.

## Alternatives considérées

### Service vidéo externe

Écarté pour le lancement local : authentification, coût, transfert de contenu et dépendance réseau inutiles.

### Projet Remotion séparé

Écarté pour le premier incrément : plus de processus et de versionnement à maintenir. Le moteur intégré garde un seul cycle de tests et de démarrage.

### Génération libre de code vidéo par Codex

Écartée : trop imprévisible et plus difficile à sécuriser. Les briefs structurés et modèles versionnés donnent un rendu reproductible et vérifiable.

## Critères d'acceptation

- Chaque projet existant ou nouveau possède un agent vidéo et une conversation persistante distincte.
- Le Studio vidéo est visible dans son cockpit et utilisable par une personne non technique.
- Une demande produit réellement un MP4 vertical lisible et une miniature en local.
- La progression, l'échec et les conclusions affichés correspondent à l'état réel.
- Aucun réseau social, fournisseur externe, paiement ou déploiement n'est déclenché.
- Les tests d'isolation, de validation, de reprise, d'API, de rendu et de responsive passent.
