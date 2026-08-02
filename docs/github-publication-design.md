# Publication GitHub de Company OS

## Compréhension validée

- Le dépôt Company OS sera publié publiquement sur GitHub.
- Le README doit être complet, accessible et entièrement bilingue français–anglais.
- La documentation publique ne doit révéler aucun secret, identifiant local, contenu client ou chemin personnel.
- Company OS reste un outil local ; sa publication ne transforme pas le cockpit en service Internet.
- L’usage non commercial est gratuit, tandis que l’usage commercial nécessite une licence payante séparée.
- Le projet doit être décrit comme `source-available`, et non comme open source au sens de l’OSI.

## Hypothèses

- Le dépôt public sera `alex97451/company-os`.
- Le profil GitHub du propriétaire servira de premier point de contact pour les demandes commerciales.
- Les tarifs et contrats commerciaux seront négociés séparément et ne sont pas publiés dans le dépôt.
- La documentation cible d’abord Windows, qui est la plateforme réellement vérifiée.

## Décisions

| Décision | Alternatives | Motif |
| --- | --- | --- |
| README français puis anglais | Anglais seul, fichiers séparés | Une page unique reste facile à découvrir et sert les deux publics. |
| PolyForm Noncommercial 1.0.0 | Prosperity 3.0, licence personnalisée | Elle autorise clairement les usages non commerciaux sans accorder d’essai commercial automatique. |
| Licence commerciale séparée | Tarif automatique public | Le propriétaire conserve la liberté de fixer les conditions selon l’usage. |
| Statut `source-available` | Présentation `open source` | Une restriction commerciale est incompatible avec la définition Open Source de l’OSI. |
| Documentation honnête du statut local | Promesses de production | Le dépôt doit distinguer les capacités vérifiées des ambitions futures. |

## Risques reconnus

- La licence ne remplace pas un conseil juridique professionnel, particulièrement pour un contrat commercial important.
- Le nom juridique du titulaire et un canal commercial dédié pourront remplacer le pseudonyme GitHub avant les premières licences payantes.
- Les badges et l’URL de clonage supposent que le dépôt public conserve le nom `alex97451/company-os`.
