# ELEVATE — Page d'inscription (vidéo 13 min)

Page statique + fonction serverless Vercel qui envoie les leads dans **Systeme.io** (les relances email restent gérées par Systeme.io).

```
index.html           → la page
api/subscribe.js     → reçoit le formulaire, crée le contact Systeme.io, ajoute le tag, envoie le Lead à Meta (CAPI)
vercel.json
```

## 1. Préparer Systeme.io
1. **Profil → Clés API publiques** → générer une clé.
2. Le tag `ELEVATE - Optin video` est **créé automatiquement** au premier lead (ou fixer `SYSTEMEIO_TAG_ID`).
3. **Automatisations → Règles** : *Déclencheur* « Tag ajouté : ELEVATE - Optin video » → *Actions* « Inscrire à la campagne email » (email d'accès à la vidéo + relances RDV).
4. **Contacts → Champs** : vérifier le slug du champ téléphone (par défaut `phone_number`).
5. Noter l'URL de la **page vidéo** Systeme.io.

## 2. Déployer
1. Pousser ce dossier dans un dépôt GitHub.
2. Vercel → **Add New Project** → importer le dépôt (aucun framework, aucun build).
3. **Settings → Environment Variables** :

| Variable | Obligatoire | Exemple |
|---|---|---|
| `SYSTEMEIO_API_KEY` | oui | clé API |
| `SYSTEMEIO_TAG_NAME` | non | `ELEVATE - Optin video` |
| `SYSTEMEIO_TAG_ID` | non | `1234567` (prioritaire) |
| `VIDEO_PAGE_URL` | oui | `https://systeme.elevatelifinsy.com/visionnage` |
| `SYSTEMEIO_PHONE_SLUG` | non | `phone_number` |
| `META_PIXEL_ID` | non | pour l'API Conversions |
| `META_CAPI_TOKEN` | non | Gestionnaire d'événements → Paramètres |

4. Redéployer après avoir ajouté les variables.

## 3. Pixel Meta
Dans `index.html`, bloc `ELEVATE_CONFIG` : renseigner `META_PIXEL_ID`.
Événements envoyés : `PageView`, `OuverturePopup` (personnalisé, avec la source du clic), `Lead` (navigateur + serveur, dédupliqués par `event_id`).

## 4. Tester
Remplir le formulaire avec un email de test → vérifier dans Systeme.io que le contact existe **avec le tag**, que l'email part, et que la redirection vers la page vidéo fonctionne. Vérifier `Lead` dans l'outil de test d'événements Meta.
