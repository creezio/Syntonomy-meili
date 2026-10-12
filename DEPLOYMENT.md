# Syntonomy Meili — VPS TempoFlow

Fork de [Meilisearch Manager](https://github.com/connorabbas/meilisearch-manager), avec sa licence MIT conservée.

- Checkout permanent : `/opt/docker/syntonomy-meili` sur `tempoflow-vps`.
- Dashboard : `https://syntonomy-meili.tempoflow.fr`.
- API du moteur personnel : `https://meili.tempoflow.fr`.
- Moteur : Meilisearch Community `1.54.0`, identique à la version source Cloud lors de la migration.
- Ports publiés sur le VPS : uniquement `127.0.0.1:18920` (connexion au dashboard) et `127.0.0.1:18921` (moteur).
- Tunnel Cloudflare dédié : `syntonomy-meili`.

Le dashboard est protégé par une session signée, dans un cookie HttpOnly/Secure de huit heures. La clé Meilisearch du dashboard reste dans le processus serveur. L'API du moteur exige une clé Meilisearch et est publiée en HTTPS. Les applications conservent leurs clés API, avec la même clé maître et les mêmes identifiants de clés lors de la migration.

## Configuration privée

Les fichiers suivants restent hors de Git et du contexte Docker :

| Fichier | Contenu |
| --- | --- |
| `.env.meilisearch` | Clé maître, environnement production, limites d'indexation |
| `.env.production` | Hôte interne `http://meilisearch:7700`, clé dédiée du dashboard |
| `.env.tunnel` | Jeton du tunnel Cloudflare |
| `.dashboard-login.json` | URL, identifiant et mot de passe du dashboard |
| `.migration-source.json` | URL et clé maître de la source Cloud pendant la copie |

Protéger ces fichiers avec le mode `0600`, accessibles à l'opérateur `deploy`. Les conteneurs du dashboard et de son accès utilisent l'utilisateur Node non-root. Les données persistantes restent dans `meili-data/`. Le répertoire privé `migration/` contient les checkpoints, réglages et clés exportés pour la reprise et l'audit.

## Exploitation

```sh
cd /opt/docker/syntonomy-meili
docker build -f Dockerfile.vps -t syntonomy-meili:current .
docker compose -p syntonomy-meili up -d
docker compose -p syntonomy-meili ps
```

Le script `ops/migrate.mjs` copie les index, les documents complets et les vecteurs retournés par l'API, puis vérifie les comptes et les réglages. Il conserve un checkpoint après chaque lot acquitté. Les clés expirées sont archivées, les clés actives sont recréées avec leur UUID et leur valeur vérifiée. La source Cloud n'est ni effacée ni résiliée par la migration.

## Migration du 12 octobre 2026

L'audit a validé **590 index, 1 811 904 documents et 13 clés API actives**. Il compare également les clés primaires, les réglages, la distribution des champs, le nombre de vecteurs et cinq documents de chaque index. Une clé déjà expirée est conservée dans l'archive privée de métadonnées.

Pegolotti TEST, Syntonomy Backoffice et Certi achats utilisent désormais `https://meili.tempoflow.fr`. Le dashboard utilise directement le moteur sur le réseau Docker privé.

Une sauvegarde portable est conservée dans `meili-data/dumps/20261012-214924830.dump` (214 Mio), avec un accès réservé à root. Le rapport complet reste dans `migration/audit.json`, et le résultat de sauvegarde dans `migration/backup.json`. Ces fichiers privés ne sont pas publiés dans Git.

Les scripts `ops/audit.mjs`, `ops/cutover.mjs` et `ops/backup.mjs` utilisent la même configuration privée de migration. La bascule exige une copie terminée et un audit réussi. Ne pas relancer la copie initiale sur la destination après la mise en service.

Ne jamais écraser un index personnel déjà utilisé avec une migration de reprise. Le script de migration est destiné à la destination neuve de cette migration, avant sa mise en service.

Avant un rebuild important, vérifier l'espace disque. Réutiliser le checkout et les caches existants. Conserver la compilation en service ; ne supprimer que les temporaires propres au travail, après avoir vérifié qu'aucun processus ne les utilise.
