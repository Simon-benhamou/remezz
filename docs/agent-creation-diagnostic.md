# Agent Creation Flow – Diagnostic & Refactor Summary

## 1. Diagnostic A→Z

### 1.1 Parcours précédent
- **Frontend** : la modale "New Agent" envoyait l'intégralité du formulaire sur `POST /api/agent/start`. L'UI recevait uniquement un `jobId` et devait ensuite *poller* `/api/agent-start-status` via `pollAgentStartJob` pour suivre les phases (`validating_config`, `building_universe`, `creating_session`, `activating_agent`). Aucun feedback utilisateur précis n'était affiché hormis un loader global, ce qui laissait penser que l'application était bloquée pendant l'auto-sélection.
- **Backend** : le service `enqueueAgentStartJob` stockait un job en mémoire puis lançait `runJob` asynchrone. Les phases étaient sérialisées dans la map `jobs`. Chaque phase rappelait les mêmes validations (normalisation du payload, construction d'univers, création de session) avant d'écrire le snapshot. Les erreurs retournaient simplement un code générique (`start.universe_conflict`, `start.timeout`, etc.) que le frontend devait interpréter.
- **Auto-sélection** : tout se passait dans `agentStartJob.ts`. La sélection du symbole se faisait tardivement (phase `creating_session`). En cas de conflit ou de manque de feedback, le frontend ne voyait pas les symboles analysés et devait re-naviguer vers la dernière session active.

### 1.2 Problèmes identifiés
- **Complexité de suivi** : le découplage entre job queue et UX rendait difficile le diagnostic d'une phase lente. Aucun détail n'était partagé côté client durant la recherche d'opportunités.
- **Bug New Agent** : lorsque le job ne renvoyait pas explicitement un `sessionId`, le frontend retombait sur "dernière session active" et pouvait rouvrir un ancien agent.
- **Idempotence incertaine** : ré-exécuter le poll en cas de rafraîchissement pouvait redémarrer une phase tardive, mais sans garantie que la session n'avait pas déjà été créée.
- **Évolutivité limitée** : toute nouvelle étape (ex : validation d'API keys, inspection de l'univers) nécessitait une nouvelle phase dans le job runner et des adaptations du poller frontend.

## 2. Nouveau flux refactoré

### 2.1 Architecture backend
- **Service unifié** : `backend/src/services/agentCreationFlow.ts` remplace `agentStartJob.ts`. Le module expose :
  - `prepareAgentCreation` (validation + auto-sélection avec stockage d'un *creation context* mémoire et retour d'un `creationId`).
  - `createSessionFromPrepared` (création de session à partir du contexte pré-validé).
  - `activatePreparedAgent` (activation finale + initialisation smart agent).
  - `startAgentCreation` (pipeline complet pour compatibilité API/test sans passer par le context en trois appels).
- **Gestion d'état** : chaque `creationId` conserve `normalizedConfig`, résultats d'univers, sélection et session provisoire. Le TTL mémoire (10 min) évite l'accumulation. Toute requête suivante vérifie l'existence du contexte (`start.context_not_found`).
- **Idempotence** : la sélection crypto est figée dès `prepareAgentCreation`. Les étapes suivantes réutilisent la même configuration. En cas d'erreur, une nouvelle préparation génère un nouvel ID.
- **Progression/diagnostic** : chaque étape remplit `AgentCreationStepSnapshot` (statut, durée, métadonnées). Les routes retournent ces informations, ce qui facilite l'observabilité.

### 2.2 API
- `POST /api/agent/creation/prepare` → validation + auto-sélection, renvoie `creationId`, résumé de sélection et aperçu normalisé.
- `POST /api/agent/creation/create-session` → création session dédiée, idempotente sur le context.
- `POST /api/agent/creation/activate` → activation de l'agent, renvoie état final (`ready` ou `warming`).
- Les routes historiques `POST /api/agent/start` et `/api/start-agent` consomment désormais `startAgentCreation` et répondent directement avec le résultat final (plus de job queue). `GET /api/agent-start-status` renvoie `410` avec un message explicatif.

### 2.3 Frontend
- `SessionsPage` déclenche désormais les étapes séquentiellement via `api.prepareAgentCreation`, `api.createAgentSession`, `api.activateAgentCreation`.
- Une **barre de progression** modale (`Steps` + `Progress`) suit les 3 étapes : sélection crypto, création session, activation agent. Les messages détaillent la crypto choisie, le statut d’activation (warming vs ready) et les erreurs éventuelles.
- Le bug de navigation est corrigé : on navigue systématiquement vers `activation.sessionId` sans fallback sur la dernière session active.
- Les API obsolètes (`startAgentJob`, `getAgentStartStatus`) ont été supprimées du client.

### 2.4 Idempotence et cohérence
- Les vérifications live (API keys + balance) restent côté frontend avant d'enclencher la création.
- Les contraintes de volume/conflits sont traitées dans `selectSymbol` avec remontée d'erreurs explicites (`start.universe_conflict`).
- En cas d'échec, la modale affiche l'erreur détaillée et laisse l'utilisateur refermer la progression.

## 3. Suivi de progression & observabilité
- Chaque étape contient `status` (`pending`, `running`, `success`, `error`), `message` et métadonnées (ex : symbole auto-sélectionné, état `ready`/`warming`).
- Le frontend agrège ces informations pour calculer un pourcentage et afficher un `Alert` synthétique.
- Côté backend, le même service peut alimenter des logs ou des métriques futures (ex : `steps` renvoyés par `startAgentCreation`).

## 4. Impacts principaux
- Suppression de la job queue mémoire et de ses APIs de polling.
- Simplification des tests d'intégration : ils importent désormais `startAgentCreation` et valident directement le résultat.
- UX clarifiée : les utilisateurs voient précisément où en est l'auto-sélection et comprennent les délais potentiels.

