# Plan de Scaling Multi-User — QuantAILabs

> **Objectif** : Permettre N utilisateurs avec 20 agents chacun, en garantissant isolation des données, sécurité, et performance.
>
> **Règle d'or** : Chaque modification doit être rétro-compatible avec le fonctionnement single-user actuel. On ne casse rien.

---

## Phase 1 — Sécurité Critique (Pré-requis absolu)

*Aucun déploiement multi-user possible sans ces fixes.*

### 1.1 Supprimer l'auth bypass `REQUIRE_API_KEY=false`

**Fichier** : `backend/src/utils/security.ts` (lignes 25-27, 70-73)

**Problème** : Quand `REQUIRE_API_KEY=false` (le défaut), les requêtes passent sans `req.user`, ce qui fait que `userId: undefined` dans les queries Prisma retourne les données de TOUS les users.

**Action** :
- Lignes 25-27 : Remplacer le `return next()` par un `return res.status(401).json({ error: 'Authentication required' })`.
- Lignes 70-73 : Même chose — si le JWT échoue, rejeter la requête, ne pas laisser passer.
- Ajouter un guard global dans server.ts après l'auth middleware : vérifier que `req.user?.id` est toujours défini avant d'atteindre les routes.

**Test** : Envoyer une requête sans token → doit recevoir 401. Envoyer avec un mauvais token → 401.

---

### 1.2 Supprimer les secrets hardcodés

**Fichiers** :
- `backend/src/routes/auth.ts` ligne 12 : `REGISTRATION_CODE = 'Shira1704'`
- `backend/src/utils/security.ts` ligne 49 : fallback `'default-secret'`
- `backend/src/utils/crypto.ts` ligne 7 : sel `'apikey-salt'`

**Action** :
- `auth.ts:12` : Remplacer par `const REGISTRATION_CODE = cfg.REGISTRATION_CODE` et ajouter `REGISTRATION_CODE` dans les env vars. Crash au démarrage si absent en production.
- `security.ts:49` : Remplacer `cfg.JWT_SECRET || cfg.APP_API_KEY || 'default-secret'` par :
  ```typescript
  const JWT_SECRET = cfg.JWT_SECRET;
  if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');
  ```
- `crypto.ts:7` : Remplacer `'apikey-salt'` par `cfg.ENCRYPTION_SALT`. Crash si absent. Documenter que changer le sel invalide les clés chiffrées existantes.
- Appliquer la même logique dans `auth.ts:58-60` et `server.ts:3579` (WS JWT).

**Test** : Démarrer le serveur sans `JWT_SECRET` → crash avec message clair. Démarrer avec → fonctionne.

---

### 1.3 Supprimer ou sécuriser le legacy API key auth

**Fichier** : `backend/src/utils/security.ts` lignes 37-45

**Problème** : Si le token correspond à `APP_API_KEY`, on crée un user synthétique `{ id: 'legacy', username: 'admin' }`. Ce user partage une identité unique — toutes les données "legacy" sont mélangées.

**Action** (2 options, choisir une) :

**Option A — Supprimer** (recommandé si tous les users ont un compte) :
- Supprimer le bloc lignes 37-45.
- Supprimer les endpoints de login legacy dans `auth.ts:35-49` (login par `AUTH_USER`/`AUTH_PASS`).

**Option B — Mapper vers un vrai user** :
- Au démarrage, créer automatiquement un user admin en DB si `APP_API_KEY` est configuré.
- Ligne 38-44 : Remplacer le user synthétique par un `prisma.user.findFirst({ where: { role: 'admin' } })`.

**Test** : Envoyer une requête avec l'ancien `APP_API_KEY` → Option A: 401. Option B: fonctionne avec un vrai userId.

---

### 1.4 Ajouter le filtre `userId` sur TOUS les endpoints sans isolation

**Fichiers & lignes à modifier** :

| Endpoint | Fichier | Ligne | Fix |
|----------|---------|-------|-----|
| GET `/api/monitor/reports/daily` | `server.ts` | 3251 | Ajouter `userId: req.user!.id` dans le `where` Prisma |
| GET `/api/monitor/reports/daily/list` | `server.ts` | 3332 | Idem |
| POST `/api/monitor/reports/daily` | `server.ts` | 3436 | Ajouter `userId` dans le `where` du upsert |
| WS `broadcast()` | `server.ts` | 3624-3640 | Filtrer par `client.userId === targetUserId` en plus du symbol |

**Action détaillée pour le WS broadcast** :
```typescript
// AVANT (ligne 3624-3640)
function broadcast(symbol: string, data: any) {
  wsClients.forEach((clientData, ws) => {
    if (clientData.subscribedSymbol === symbol) ws.send(...)
  });
}

// APRÈS
function broadcastToUser(userId: string, symbol: string, data: any) {
  wsClients.forEach((clientData, ws) => {
    if (clientData.userId === userId && clientData.subscribedSymbol === symbol) {
      ws.send(...)
    }
  });
}
```

**Audit complet** : Grepper `prisma.` dans server.ts et vérifier que CHAQUE query a un `userId` dans son `where`. Liste des queries suspectes à vérifier :
- Toutes les routes inline dans server.ts (il y en a beaucoup, ~3600 lignes)
- Les routes dans `routes/user.ts` (déjà OK, utilisent `req.user!.id`)
- Les routes dans `routes/auth.ts` (OK, pas de data queries)

**Test** : Créer 2 users, chacun avec un agent. User A ne doit jamais voir les sessions/trades/reports de User B.

---

### 1.5 Sécuriser les endpoints debug

**Fichier** : `backend/src/routes/debug.ts`

**Problème** : `router.use(authenticateUser)` est à la ligne 330, APRÈS les routes publiques (lignes 11-239). Les endpoints `/test-credentials`, `/test-exchange`, `/server-ip`, `/atr-cache-stats` sont publics.

**Action** :
- Déplacer `router.use(authenticateUser)` **avant** toutes les routes (après les imports, ~ligne 10).
- Exception possible : `/server-ip` peut rester public si nécessaire (ou le supprimer).
- `/test-credentials` (ligne 101) : Déplacer derrière auth ET utiliser les credentials de l'user authentifié depuis la DB au lieu d'accepter des credentials brutes dans le body.
- Supprimer les `console.log` des prefixes de clés API (lignes 113-114).

**Test** : Appeler `/api/debug/test-credentials` sans token → 401.

---

### 1.6 Masquer les clés API dans les réponses HTTP

**Fichier** : `backend/src/routes/user.ts`

**Action** :
- Ligne 30 : Remplacer `apiKey: decryptApiKey(key.apiKey)` par :
  ```typescript
  apiKey: maskKey(decryptApiKey(key.apiKey)) // "BnZ4...xK9q"
  ```
  Avec `maskKey(key: string) => key.slice(0,4) + '...' + key.slice(-4)`.
- Lignes 337-371 : L'endpoint `/api-keys/:exchange/credentials` qui retourne les clés en clair :
  - **Option A** : Le supprimer complètement. Le backend a déjà les clés et les utilise directement.
  - **Option B** : Le garder mais le protéger avec une re-authentification (demander le mot de passe).

**Test** : Appeler GET `/api/api-keys` → les clés sont masquées. Inspecter le JSON : pas de clé complète.

---

### 1.7 Appliquer les rate limiters existants

**Fichiers** :
- `backend/src/middleware/rateLimit.ts` (déjà écrit, jamais importé)
- `backend/src/server.ts` (ajouter les imports + `app.use()`)

**Action** :
```typescript
// Dans server.ts, après les imports existants
import { createAgentRateLimiters, createMonitorRateLimiters } from './middleware/rateLimit';

// Après le CORS middleware, avant les routes
app.use('/api/sessions', ...createAgentRateLimiters());
app.use('/api/monitor', ...createMonitorRateLimiters());
```

- Ajouter un rate limiter spécifique sur `/api/auth/login` et `/api/auth/register` : max 5 tentatives par minute par IP.
- Ajouter un rate limiter global : max 300 req/min par user.

**Test** : Envoyer 200 requêtes en 1 minute → les dernières reçoivent 429.

---

### 1.8 Nettoyage complet au logout (Frontend)

**Fichiers** :
- `frontend/src/components/UserDropdown.tsx` lignes 42-48
- `frontend/src/hooks/useDataCache.ts` ligne 66 (globalCache), ligne 277 (clearAllCache)
- `frontend/src/hooks/useMultiDataCache.ts` ligne 71 (globalMultiCache)

**Action** :
1. Créer `frontend/src/lib/logout.ts` :
   ```typescript
   import { clearAllCache } from '@/hooks/useDataCache';
   import { clearAllMultiCache } from '@/hooks/useMultiDataCache';
   import { useAppStore } from '@/store';

   export function fullLogout() {
     // 1. Clear in-memory caches
     clearAllCache();
     clearAllMultiCache(); // ← à exporter depuis useMultiDataCache.ts

     // 2. Clear all localStorage
     const keys = Object.keys(localStorage);
     keys.forEach(key => localStorage.removeItem(key));

     // 3. Reset Zustand stores
     useAppStore.getState().logout();

     // 4. Hard reload to kill all WS connections and module-level state
     window.location.href = '/login';
   }
   ```
2. Exporter `clearAllMultiCache()` depuis `useMultiDataCache.ts`.
3. Remplacer le handler dans `UserDropdown.tsx` par un appel à `fullLogout()`.

**Test** : Login User A → naviguer → logout → login User B → aucune donnée de User A visible.

---

## Phase 2 — Architecture Multi-User (Scalabilité)

*Ces changements permettent de passer de 1-3 users à 50+ users.*

### 2.1 Order Queue per-user

**Fichier** : `backend/src/services/orderQueue.ts`

**Problème** : Un singleton global avec 3 slots et 350ms de delay. User A bloque User B.

**Architecture cible** :
```
OrderQueueManager (singleton)
├── UserQueue (userId: "abc") → 3 slots, 350ms delay
├── UserQueue (userId: "def") → 3 slots, 350ms delay
├── UserQueue (userId: "ghi") → 3 slots, 350ms delay
└── GlobalRateLimiter → respect du rate limit IP Binance (1200 poids/min)
```

**Action détaillée** :
1. Créer une classe `UserOrderQueue` avec la même logique que l'actuel `OrderQueue` mais instanciée par user.
2. Créer un `OrderQueueManager` qui :
   - Maintient une `Map<string, UserOrderQueue>` par userId.
   - Crée la queue à la demande (`getOrCreate(userId)`).
   - Cleanup les queues inactives après 30 minutes sans ordre.
   - Applique un **rate limiter global partagé** pour respecter les limites IP Binance.
3. Modifier l'export singleton (ligne 839-849) :
   ```typescript
   // AVANT
   export const orderQueue = new OrderQueue(...);

   // APRÈS
   export const orderQueueManager = new OrderQueueManager();
   // API: orderQueueManager.enqueue(userId, orderRequest)
   ```
4. Mettre à jour tous les appelants de `orderQueue.enqueue(...)` :
   - `exchangeOrderManager.ts` : utiliser `orderQueueManager.enqueue(this.userId, ...)`
   - `simpleAgent.ts` : idem pour les appels directs
   - `positionOpener.ts` : idem
   - `server.ts` : idem pour les routes qui enqueue des ordres

**Config par user** :
```typescript
const PER_USER_CONFIG = {
  MAX_CONCURRENT: 3,           // 3 ordres simultanés par user
  ORDER_DELAY_MS: 200,         // 200ms entre ordres (même user)
  MAX_QUEUE_SIZE: 100,         // 100 ordres max en queue par user
};

const GLOBAL_CONFIG = {
  MAX_GLOBAL_RATE: 10,         // 10 ordres/sec max tous users confondus (limit IP)
  WEIGHT_BUDGET_PER_MIN: 1100, // 1200 poids/min Binance - 100 de marge
};
```

**Test** : 2 users enqueue simultanément → les ordres de chacun sont traités en parallèle, pas séquentiellement.

---

### 2.2 Limites per-user (agents, connexions, capital)

**Fichier** : `backend/src/server.ts` (agent management, lignes 232-289)

**Action** :
1. Ajouter une constante `MAX_AGENTS_PER_USER = 20` dans `config/constants.ts`.
2. Dans la route de création d'agent, avant `createAgent()` :
   ```typescript
   const currentCount = userAgents.get(`${userId}_${mode}`)?.size ?? 0;
   if (currentCount >= MAX_AGENTS_PER_USER) {
     return res.status(429).json({ error: `Maximum ${MAX_AGENTS_PER_USER} agents reached` });
   }
   ```
3. Ajouter `MAX_WS_CONNECTIONS_PER_USER = 5` — dans le handler WS (server.ts:3565), compter les connexions par userId et rejeter au-delà.
4. Ajouter une table `UserLimits` en DB (ou un champ dans User) pour les limites personnalisées par tier.

**Test** : Essayer de créer un 21ème agent → 429 avec message clair.

---

### 2.3 Isoler le `globalSignalRanker` par user

**Fichier** : `backend/src/strategies/simpleAgent.ts` ligne 920

**Problème** : `globalSignalRanker.removeSignal(symbol, mode)` — si 2 users tradent BTC en live, l'un peut supprimer le signal de l'autre.

**Action** :
1. Modifier le `SignalRanker` pour accepter un `userId` dans sa clé :
   ```typescript
   // Clé actuelle: `${symbol}_${mode}`
   // Nouvelle clé: `${userId}_${symbol}_${mode}`
   ```
2. Mettre à jour tous les appels à `addSignal()` et `removeSignal()` pour passer le `userId`.
3. Les rankings sont calculés per-user (chaque user a son propre classement de signaux).

**Impact** : ~10-15 endroits à modifier dans `simpleAgent.ts`. Chercher tous les usages de `globalSignalRanker`.

---

### 2.4 Configuration des symboles per-user

**Fichier** : `backend/src/strategies/simpleAgent.ts` lignes 3666-3711

**Problème** : `MomentumConfig.SYMBOLS` est global et partagé par tous les users. La fonction `createAllAgents` a un `sessionIdMap` hardcodé pour 4 symboles.

**Action** :
1. Stocker la liste de symboles par user dans la DB (table `UserConfig` ou champ dans `AgentSession`).
2. Modifier `createAllAgents` pour accepter la config dynamiquement :
   ```typescript
   async function createUserAgents(userId: string, sessions: AgentSession[]) {
     for (const session of sessions) {
       const symbol = session.symbol; // depuis la DB
       const agent = new SimpleAgent({ userId, symbol, ... });
       await agent.start();
     }
   }
   ```
3. `MomentumConfig.SYMBOLS` reste comme default/fallback mais n'est plus la source de vérité.

---

### 2.5 Configurer le pool de connexions DB

**Fichier** : `backend/prisma/schema.prisma` (datasource block)

**Action** :
- Ajouter `connection_limit` dans l'URL PostgreSQL :
  ```
  DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=20&pool_timeout=30"
  ```
- Pour 50 users : `connection_limit=20` suffit (les queries sont légères et rapides).
- Pour 200+ users : utiliser **PgBouncer** devant PostgreSQL en mode transaction pooling.

---

### 2.6 Multiplexer les WebSockets frontend

**Fichiers frontend** :
- `frontend/src/providers/TradeNotificationProvider.tsx` ligne 248
- `frontend/src/hooks/useOpsJobs.ts` ligne 9
- `frontend/src/hooks/useSessionState.ts` ligne 589
- `frontend/src/pages/FeedPage.tsx` ligne 106
- `frontend/src/ws.ts`

**Problème** : 4 connexions WS indépendantes par tab. Avec N users × M tabs = N×M×4 connexions.

**Architecture cible** :
```
1 connexion WS par tab
├── channel: "notifications"  (remplace TradeNotificationProvider WS)
├── channel: "ops-jobs"       (remplace useOpsJobs WS)
├── channel: "session:{id}"   (remplace useSessionState WS)
└── channel: "feed"           (remplace FeedPage WS)
```

**Action** :
1. Modifier `ws.ts` pour créer un **singleton WS** avec un système de channels/subscriptions :
   ```typescript
   class WsManager {
     private ws: WebSocket | null = null;
     private subscriptions = new Map<string, Set<(data: any) => void>>();

     subscribe(channel: string, callback: (data: any) => void): () => void { ... }
     unsubscribe(channel: string, callback: (data: any) => void): void { ... }
     private handleMessage(event: MessageEvent): void {
       const { channel, data } = JSON.parse(event.data);
       this.subscriptions.get(channel)?.forEach(cb => cb(data));
     }
   }
   export const wsManager = new WsManager();
   ```
2. Adapter le backend WS server pour router les messages par channel.
3. Migrer chaque composant frontend pour utiliser `wsManager.subscribe('channel', callback)`.

**Test** : Ouvrir DevTools → Network → WS : une seule connexion, messages taggés par channel.

---

### 2.7 Ajouter un body size limit

**Fichier** : `backend/src/server.ts` ligne 189

**Action** :
```typescript
// AVANT
app.use(express.json());

// APRÈS
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
```

---

### 2.8 Réduire le polling frontend (optimisation backend-push)

**Fichiers** : `frontend/src/hooks/useDashboard.ts`, `useSessionsCache.ts`, `useSessionState.ts`, `useReportsCache.ts`

**Action** :
1. Pour les données temps-réel (positions, prix, PnL) : pousser via le WS multiplexé (2.6) au lieu de polling.
2. Pour les données semi-statiques (sessions list, reports) : augmenter les intervalles :
   - Dashboard overview : 15s → 30s (ou WS push)
   - Sessions list : 20s → 60s
   - Session cockpit : garder 30s mais ajouter `document.visibilityState` check
   - Reports : 60s → 120s
3. Ajouter un check `document.hidden` dans tous les polling hooks :
   ```typescript
   useEffect(() => {
     const interval = setInterval(() => {
       if (!document.hidden) refresh();
     }, INTERVAL_MS);
     return () => clearInterval(interval);
   }, []);
   ```

---

## Phase 3 — Hardening & Production Readiness

*Renforce la robustesse et prépare le déploiement production.*

### 3.1 Ajouter un Content Security Policy

**Fichier** : `frontend/index.html`

**Action** :
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self';
           script-src 'self';
           style-src 'self' 'unsafe-inline';
           connect-src 'self' wss://*.quantailabs.com;
           img-src 'self' data:;
           font-src 'self';">
```

---

### 3.2 Supprimer les console.log du build de production

**Fichier** : `frontend/vite.config.ts`

**Action** :
```typescript
export default defineConfig({
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
  // ... rest
});
```

---

### 3.3 Transactions DB sur les opérations critiques

**Fichier** : `backend/src/strategies/positionPersistence.ts`

**Action** : Wrapper les opérations d'ouverture/fermeture de position dans des transactions :
```typescript
await prisma.$transaction(async (tx) => {
  await tx.position.create({ ... });
  await tx.order.create({ ... });
  await tx.fill.create({ ... });
  await tx.agentSession.update({ ... });
});
```

Idem pour la fermeture (position.update + order + fill + sessionKpi.upsert + session.update).

---

### 3.4 Ajouter un health check endpoint

**Fichier** : `backend/src/server.ts`

**Action** : Ajouter AVANT le middleware auth :
```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    agents: userAgents.size,
    wsClients: wsClients.size,
  });
});
```

---

### 3.5 Renforcer les mots de passe

**Fichiers** :
- `backend/src/routes/auth.ts` (registration)
- `frontend/src/pages/SettingsPage.tsx` ligne 103

**Action** :
- Backend : Ajouter une validation password dans la route register :
  ```typescript
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });
  ```
- Frontend : Mettre à jour le schema Zod : `z.string().min(10, 'Minimum 10 characters')`.

---

### 3.6 Nettoyer les variables d'environnement frontend

**Fichier** : `frontend/src/api.ts` lignes 33-35

**Action** : Supprimer le bloc `VITE_APP_API_KEY` :
```typescript
// SUPPRIMER ces lignes — une API key ne doit jamais être bakée dans un bundle JS
// if (import.meta.env.VITE_APP_API_KEY) {
//   client.defaults.headers.common['x-api-key'] = import.meta.env.VITE_APP_API_KEY;
// }
```

---

### 3.7 Supprimer l'IP serveur hardcodée

**Fichier** : `frontend/src/pages/SettingsPage.tsx` lignes 416, 508

**Action** : Remplacer les références à `208.77.244.15` par un appel API (via le health check 3.4) ou supprimer complètement si non nécessaire.

---

### 3.8 Cascade delete pour les trades orphelins

**Fichier** : `backend/prisma/schema.prisma`

**Action** : Vérifier que la relation Session → Trade a `onDelete: Cascade` :
```prisma
model Trade {
  session   AgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  // ...
}
```

Idem pour Position, Order, Fill, DailyReport par rapport à leur Session parent.

Créer et exécuter une migration : `npx prisma migrate dev --name cascade-deletes`.

---

## Ordre d'exécution recommandé

```
Jour 1 : Phase 1.1 + 1.2 + 1.3         (auth — ~3h)
Jour 2 : Phase 1.4 + 1.5 + 1.6 + 1.7   (isolation + rate limits — ~4h)
Jour 3 : Phase 1.8 + tests              (frontend logout + test global — ~2h)
─── Point de contrôle : test multi-user basique ───
Jour 4 : Phase 2.1                       (per-user queue — ~4h, le plus complexe)
Jour 5 : Phase 2.2 + 2.3 + 2.4          (limites + signal ranker + symbols — ~3h)
Jour 6 : Phase 2.5 + 2.6 + 2.7 + 2.8   (DB pool + WS mux + polling — ~4h)
─── Point de contrôle : stress test multi-user ───
Jour 7 : Phase 3.1 → 3.8               (hardening — ~3h)
─── Audit final + déploiement ───
```

## Checklist de validation finale

- [ ] 2 users créés, chacun avec 5 agents
- [ ] User A ne voit JAMAIS les données de User B (sessions, trades, reports, WS)
- [ ] Logout de User A + login User B → aucune donnée résiduelle
- [ ] 20 agents par user fonctionnent sans dégradation
- [ ] Les ordres de User A ne bloquent pas ceux de User B
- [ ] Rate limiting fonctionne (429 au-delà du seuil)
- [ ] Endpoints debug protégés par auth
- [ ] Clés API masquées dans les réponses HTTP
- [ ] Pas de secrets dans le code source
- [ ] Health check `/health` accessible
- [ ] Un seul WS par tab browser
- [ ] `console.log` absents du build production
