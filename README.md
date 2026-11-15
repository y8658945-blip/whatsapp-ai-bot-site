<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:d7ba4e76724b3e1d741785139e36d7808ca3046973cc3ca3e0220d82edf34415 -->

# Site privé WhatsApp AI Bot

Ce dépôt privé héberge le site public de création de SESSION_ID, le tutoriel et l’administration du propriétaire. Le bot distribuable reste dans [WhatsApp-ai-bot](https://github.com/y8658945-blip/WhatsApp-ai-bot).

## Lancer

Node.js 22, puis :

```bash
npm install
cp .env.example .env
npm start
```

- `/` : génération publique par code ou QR, catalogue et tutoriel.
- `/admin` : ton compte WhatsApp et ses opérations (appairage, import, export, déconnexion).
- `/health` : disponibilité HTTP.
- `npm test` : tests hors ligne du bot, du site et de l’isolation des visiteurs.

## Configuration

`ADMIN_PASSWORD` protège uniquement l’administration. Sans cette variable, l’admin reste désactivé et la génération publique fonctionne. Choisis un mot de passe long et unique dans Render ; ne le mets pas dans GitHub. L’accès admin expire après une heure et utilise un cookie HttpOnly, SameSite=Strict, Secure lorsque l’URL publique est HTTPS. Le bouton « Fermer mon accès admin » invalide ce cookie sans déconnecter WhatsApp.

`MAX_PUBLIC_SESSIONS` limite les sessions simultanées (10 par défaut, de 1 à 50). Chaque navigateur conserve un jeton de session dans son onglet. Les identifiants WhatsApp des visiteurs restent en mémoire, sans MongoDB ni fichier. Les sockets et données sont supprimés à l’expiration de 10 minutes, à la suppression volontaire, ou à l’arrêt du service. La lecture du SESSION_ID ferme le socket sans révoquer l’appareil. Les visiteurs déploient leur bot avec ce SESSION_ID ; aucun bot permanent n’est démarré pour eux ici. Leurs messages ne sont pas traités par ton bot.

`SESSION_ID`, `NVIDIA_API_KEY`, `MONGODB_URI` et les autres réglages du bot concernent **ton compte propriétaire uniquement**. Conserve tes variables existantes lors de la migration Render. Les limites et jetons sont en mémoire : utilise **une instance** du service. Pour plusieurs instances, il faudrait un routage et un stockage partagés adaptés.

Sur Render, l’adresse du client fournie par le proxy est utilisée pour limiter les créations et les essais admin. En local, l’adresse du socket est utilisée. Ne déploie pas derrière un autre proxy sans adapter cette frontière de confiance.

## Migrer le service Render existant

Objectif : conserver https://whatsapp-ai-bot-tenm.onrender.com et ses variables existantes.

1. Dans l’intégration GitHub de Render, autorise le dépôt privé `y8658945-blip/whatsapp-ai-bot-site`.
2. Ouvre **le service existant**, puis **Settings → Build & Deploy**. Relie le nouveau dépôt privé si l’option de modification du dépôt est proposée. <!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:f093a8ec132c26f5cb801298418ff6d441c8f9d60a3b172656c9dd4107f65e72 -->

Choisis la branche qui contient le nouveau code : `coderabbit/public-sessions-admin-guide/57dc55de` pour la publication préparée par cette tâche, ou `main` après un import manuel.

<!-- /coderabbit-ai-generated:v1 --> Ne recrée pas un service si tu veux conserver l’adresse actuelle.
3. Conserve toutes les variables actuelles, notamment `SESSION_ID`, `NVIDIA_API_KEY`, `MONGODB_URI` et `ADMIN_PASSWORD`. Ajoute `MAX_PUBLIC_SESSIONS=10`. Utilise Node.js 22, build `npm install --omit=dev`, démarrage `npm start`, contrôle de santé `/health`.
4. Lance **Manual Deploy → Deploy latest commit**. Vérifie `/health`, puis ouvre le site public dans une fenêtre privée : il ne doit montrer aucun compte propriétaire et doit proposer un code sans mot de passe.
5. Vérifie `/admin` avec ton mot de passe. Vérifie qu’une fenêtre sans cookie reçoit 401 sur `/api/admin/status` et `/api/admin/session`.
6. Quand le service fonctionne depuis le dépôt privé, la branche de séparation du dépôt public peut être fusionnée. La fusion publique ne doit pas précéder le changement Render : elle retirerait le site de l’ancien service.

Si Render n’autorise pas le changement de dépôt dans ce service, consulte [la documentation de liaison GitHub](https://render.com/docs/github) ou l’assistance Render pour conserver cette URL. Créer un nouveau service donne généralement une nouvelle adresse. Ce fichier ne constitue pas une preuve que la migration a été effectuée.

## Historique et publication

Le code du site était précédemment présent dans le dépôt public. Le retirer de la version courante ne retire pas les anciennes révisions Git ni les copies déjà récupérées. Aucune réécriture de cet historique n’est prévue.

Le site utilise Baileys, une bibliothèque non officielle. La validation hors ligne ne remplace pas un appairage réel sur ton propre téléphone.


<!-- /coderabbit-ai-generated:v1 -->