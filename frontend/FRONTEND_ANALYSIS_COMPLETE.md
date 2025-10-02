# 🔍 ANALYSE COMPLÈTE FRONTEND - Bugs & Solutions

**Date**: 2 octobre 2025  
**Status**: ⚠️ REFACTORING CRITIQUE NÉCESSAIRE

---

## 🚨 BUGS CRITIQUES IDENTIFIÉS

### 1. **BUG MAJEUR: Switch Live/Paper - Liste Sessions Incorrecte**

**Localisation**: `SessionsPage.tsx` lignes 83-136

**Symptômes**:
- Quand tu switch de Paper → Live, tu vois encore les sessions Paper
- La liste ne se rafraîchit pas correctement
- Le cache ne s'invalide pas au bon moment

**Cause racine**:
```typescript
// ❌ PROBLÈME: Le cache utilise le mode mais le filtre n'est pas appliqué côté API
const load = React.useCallback(async (forceRefresh = false) => { 
  console.log(`🔄 Loading sessions for mode: ${mode}`);
  
  // Le mode est passé mais l'API ne filtre peut-être pas correctement
  const sessions = await loadSessions(mode as any, false, forceRefresh);
  const enrichedSessions = await enrichSessionData(sessions);
  setRows(enrichedSessions); // ← Affiche TOUTES les sessions, pas juste celles du mode
}, [mode, loadSessions]);
```

**Backend check nécessaire**:
```typescript
// backend/src/routes/agent.ts - Vérifier que le filtre mode fonctionne
router.get('/sessions', async (req, res) => {
  const { mode } = req.query; // ← Ce filtre est-il appliqué ?
  
  // Si mode présent, FILTRER les sessions
  if (mode) {
    sessions = sessions.filter(s => s.mode === mode);
  }
});
```

**Solution Frontend**:
```typescript
// Fix 1: Forcer le filtre côté client aussi (défense en profondeur)
const load = React.useCallback(async (forceRefresh = false) => { 
  const sessions = await loadSessions(mode as any, false, forceRefresh);
  
  // ✅ FILTRER explicitement par mode
  const filteredByMode = sessions.filter((s: any) => s.mode === mode);
  
  const enrichedSessions = await enrichSessionData(filteredByMode);
  setRows(enrichedSessions);
}, [mode, loadSessions]);

// Fix 2: Invalider le cache lors du switch de mode
React.useEffect(() => {
  console.log(`📋 Mode changed to: ${mode}`);
  
  // ✅ INVALIDER le cache de l'ancien mode
  invalidateCache(); // Clear tout
  
  // Forcer un refresh complet
  load(true);
}, [mode]);
```

---

### 2. **BUG: Monitoring ne reflète pas l'état réel de l'agent**

**Localisation**: `MonitorPage.tsx` lignes 120-180

**Symptômes**:
- Les diagnostics ne s'affichent pas toujours
- L'état de l'agent (ARMED/MANAGE) n'est pas synchronisé en temps réel
- Les triggers de trading ne sont pas visibles

**Cause racine**:
```typescript
// ❌ PROBLÈME: Chargement progressif trop lent + timeout trop court
const loadData = async () => {
  const loadingTimeout = setTimeout(() => {
    updateProgress(LoadingPhase.COMPLETE, 100, 'Load timeout - continuing', ...);
  }, 8000); // ← 8 secondes = trop court pour tout charger
  
  // Données critiques chargées trop tard
  const [analyticsData, healthData, triggersData] = await Promise.allSettled([...]);
  // Phase 3 = données monitoring = non-critiques ???
  // ❌ ERREUR: Les diagnostics sont CRITIQUES pour comprendre pourquoi l'agent n'entre pas
};
```

**Solution**:
```typescript
// ✅ Fix 1: Augmenter timeout + prioriser différemment
const loadData = async () => {
  const loadingTimeout = setTimeout(() => {
    updateProgress(LoadingPhase.COMPLETE, 100, 'Continuing with available data');
  }, 20000); // 20 secondes
  
  // Phase 1: Session + Agent State + Diagnostics (CRITIQUE)
  const [s, agentData, diagnosticsData] = await Promise.allSettled([
    api.status(sessionId),
    api.getAgentState(sessionId),
    api.getDiagnostics(sessionId) // ← Maintenant en Phase 1 !
  ]);
  
  // Phase 2: Trading data
  // Phase 3: Analytics non-critiques
};

// ✅ Fix 2: WebSocket pour updates temps réel
// Le WS existe mais ne notifie pas les changements d'état agent
ws.onmessage = (msg) => {
  if (msg.type === 'agent_state') {
    setAgent(msg.data);
    
    // ✅ AJOUTER: Refresh diagnostics automatiquement
    api.getDiagnostics(sessionId).then(setDiagnostics);
  }
  
  if (msg.type === 'diagnostics_update') { // ← NOUVEAU type de message
    setDiagnostics(msg.data);
  }
};
```

---

### 3. **BUG: Chart ne montre pas les niveaux corrects**

**Localisation**: `PriceChart.tsx` lignes 180-250

**Symptômes**:
- Entry zone affichée mais pas à jour
- Support/Resistance pas visibles
- Target/Stop ne correspondent pas à ce que l'agent voit

**Cause racine**:
```typescript
// ❌ PROBLÈME: Multiples sources de vérité pour les niveaux
React.useEffect(()=> {
  // Source 1: Strategy classique (peut être obsolète)
  const zmin = strategy?.entry?.zone?.min;
  const zmax = strategy?.entry?.zone?.max;
  
  // ...
}, [strategy]);

React.useEffect(()=> {
  // Source 2: Agent plan (surcharge la source 1)
  const zmin = agentPlan?.zone?.from;
  const zmax = agentPlan?.zone?.to;
  
  // ❌ Problème: Si agentPlan change, strategy n'est pas cleared
  // Résultat: Overlap de 2 entry zones différentes
}, [agentPlan, agentPos]);
```

**Solution**:
```typescript
// ✅ Fix: Source de vérité unique = Agent state
React.useEffect(()=> {
  // Nettoyer TOUTES les price lines
  const removeAllLines = () => {
    [plEntryMin, plEntryMax, plSL, plTP, plSupport, plResistance].forEach(ref => {
      if (ref.current && seriesRef.current) {
        try { seriesRef.current.removePriceLine(ref.current); } catch {}
        ref.current = null;
      }
    });
  };
  
  removeAllLines();
  
  // Recréer UNIQUEMENT depuis agent state (source unique)
  if (agentPlan) {
    const zmin = agentPlan?.zone?.from;
    const zmax = agentPlan?.zone?.to;
    const sl = agentPos?.stop || calculateStop(agentPlan);
    const tp = agentPlan?.rPrices?.[0]?.price;
    
    if (zmin) plEntryMin.current = seriesRef.current.createPriceLine({ 
      price: zmin, 
      title: 'Entry Min', 
      color: '#2ecc71',
      lineWidth: 2 
    });
    
    // ... same pour les autres niveaux
  }
  
  // Support/Resistance depuis status.sr (backend calcule)
  if (status?.sr) {
    if (status.sr.support) plSupport.current = seriesRef.current.createPriceLine({
      price: status.sr.support,
      title: 'Support',
      color: '#e74c3c',
      lineStyle: LineStyle.Dashed
    });
    
    // ... resistance
  }
}, [agentPlan, agentPos, status]);
```

---

### 4. **BUG: État de l'agent pas synchronisé**

**Localisation**: `AgentStatePanel.tsx` + `MonitorPage.tsx`

**Symptômes**:
- Agent dit "ARMED" mais on voit pas pourquoi il n'entre pas
- Diagnostics disent "Can trade: false" mais raison pas claire
- Quality score pas affiché correctement

**Cause racine**:
```typescript
// ❌ PROBLÈME: Diagnostics pas assez visibles
<Card title="Agent State">
  <div>State: {agent.state}</div>
  
  // ❌ Diagnostics enterrés dans un collapse ou onglet
  <TradingDiagnosticsCollapsible ... />
</Card>
```

**Solution**:
```typescript
// ✅ Fix: Afficher diagnostics EN PREMIER, bien visible
<Space direction="vertical" size="large" style={{ width: '100%' }}>
  {/* 1. DIAGNOSTICS EN PREMIER - Pourquoi je trade pas ? */}
  {!agent?.pos && (
    <Alert
      type={diagnostics?.canTrade ? 'success' : 'warning'}
      message={diagnostics?.canTrade ? '✅ Ready to Trade' : '⚠️ Trading Blocked'}
      description={
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {diagnostics?.reason || 'Checking conditions...'}
          </div>
          
          {/* Quality Score Progress */}
          {diagnostics?.checks?.qualityScore && (
            <div>
              <div style={{ marginBottom: 4 }}>
                Quality Score: {diagnostics.checks.qualityScore.current} / {diagnostics.checks.qualityScore.required}
              </div>
              <Progress 
                percent={(diagnostics.checks.qualityScore.current / diagnostics.checks.qualityScore.required) * 100}
                strokeColor={diagnostics.canTrade ? '#52c41a' : '#faad14'}
                size="small"
              />
            </div>
          )}
          
          {/* Liste des checks */}
          <div style={{ marginTop: 12, fontSize: 12 }}>
            {diagnostics?.checks?.list?.map((check: any) => (
              <div key={check.name}>
                {check.pass ? '✅' : '❌'} {check.name}: {check.message}
              </div>
            ))}
          </div>
        </div>
      }
      showIcon
      style={{ marginBottom: 16 }}
    />
  )}
  
  {/* 2. ÉTAT AGENT */}
  <Card title="Agent State">
    <Descriptions column={1} size="small">
      <Descriptions.Item label="State">
        <Tag color={agent.state === 'ARMED' ? 'green' : 'blue'}>
          {agent.state}
        </Tag>
      </Descriptions.Item>
      
      {/* 3. PLAN ACTIF */}
      {agent?.plan && (
        <>
          <Descriptions.Item label="Bias">
            <Tag color={agent.plan.bias === 'long' ? 'green' : 'red'}>
              {agent.plan.bias?.toUpperCase()}
            </Tag>
          </Descriptions.Item>
          
          <Descriptions.Item label="Entry Zone">
            ${agent.plan.zone?.from?.toFixed(2)} - ${agent.plan.zone?.to?.toFixed(2)}
          </Descriptions.Item>
          
          <Descriptions.Item label="Target">
            ${agent.plan.rPrices?.[0]?.price?.toFixed(2)} (+{agent.plan.rPrices?.[0]?.r?.toFixed(1)}R)
          </Descriptions.Item>
          
          <Descriptions.Item label="Stop Distance">
            ${agent.plan.stopDistance?.toFixed(2)}
          </Descriptions.Item>
        </>
      )}
    </Descriptions>
  </Card>
  
  {/* 4. POSITION (si active) */}
  {agent?.pos && (
    <PositionCard pos={agent.pos} price={lastPrice} />
  )}
</Space>
```

---

### 5. **BUG: Performance Banner données incorrectes**

**Localisation**: `PerformanceBanner.tsx`

**Symptômes**:
- Win rate affiché en décimal (0.65 au lieu de 65%)
- PnL non réalisé pas pris en compte
- ROI calculé uniquement sur realized PnL

**Cause racine**:
```typescript
// ❌ PROBLÈME: Normalisation win rate incohérente
const rawWinRate = Number(perf?.winRate ?? 0);
const normalizedWinRate = rawWinRate > 0 && rawWinRate <= 1 ? rawWinRate * 100 : rawWinRate;

// ❌ Backend renvoie parfois 0.65, parfois 65
// Frontend doit gérer les 2 cas
```

**Solution**:
```typescript
// ✅ Fix: Normalisation robuste
const normalizeWinRate = (rate: number | undefined | null): number => {
  if (!rate) return 0;
  const num = Number(rate);
  
  // Si entre 0 et 1, convertir en %
  if (num > 0 && num <= 1) {
    return Math.round(num * 100);
  }
  
  // Si entre 1 et 100, déjà en %
  if (num > 1 && num <= 100) {
    return Math.round(num);
  }
  
  // Sinon, invalide
  return 0;
};

// ✅ PnL total = realized + unrealized
const totalPnl = (perf?.realizedPnlUsd || 0) + (perf?.unrealizedPnlUsd || 0);

// ✅ ROI = (total PnL / capital initial) * 100
const roiPct = session?.startBalanceUsd 
  ? (totalPnl / session.startBalanceUsd) * 100 
  : (perf?.roiPct || 0);
```

---

## 📊 PROBLÈMES D'ALIGNEMENT BACKEND/FRONTEND

### 1. **Types de données incohérents**

**Problème**: Backend renvoie des formats différents selon l'endpoint

```typescript
// ❌ Endpoint 1: /api/agent/state
{
  plan: {
    zone: { from: 100, to: 102, mid: 101 } // ✅ OK
  }
}

// ❌ Endpoint 2: /api/strategy/today
{
  entry: {
    zone: { min: 100, max: 102 } // ❌ Noms différents !
  }
}
```

**Solution**: Standardiser au backend
```typescript
// backend/src/agent/state.ts
export interface EntryZone {
  from: number;  // ✅ Toujours "from"
  to: number;    // ✅ Toujours "to"
  mid: number;   // ✅ Toujours "mid"
}

// Deprecated: min/max (remplacer partout)
```

### 2. **WebSocket events incomplets**

**Problème**: Certains events cruciaux pas envoyés

```typescript
// ❌ Events manquants:
// - 'diagnostics_update' (quand canTrade change)
// - 'plan_updated' (quand l'agent recalcule la zone)
// - 'quality_score_change' (quand quality score évolue)
```

**Solution Backend**:
```typescript
// backend/src/ws/index.ts
export function broadcastToSession(sessionId: string, type: string, data: any) {
  wss.clients.forEach(client => {
    if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type, data, sessionId }));
    }
  });
}

// Dans agent/state.ts
private async maybeRecalculateEntryZone() {
  const oldZone = this.plan?.zone;
  const newZone = await this.calculateDynamicEntryZone(...);
  
  if (newZone !== oldZone) {
    this.plan.zone = newZone;
    
    // ✅ BROADCASTER le changement
    broadcastToSession(this.sessionId, 'plan_updated', {
      zone: newZone,
      reason: 'entry_zone_recalculated'
    });
  }
}

// Pareil pour diagnostics
private async checkTradingConditions() {
  const diagnostics = await this.buildDiagnostics();
  
  if (diagnostics.canTrade !== this.lastCanTrade) {
    this.lastCanTrade = diagnostics.canTrade;
    
    // ✅ BROADCASTER le changement
    broadcastToSession(this.sessionId, 'diagnostics_update', diagnostics);
  }
}
```

---

## 🎯 REFACTORING PROPOSÉ

### Phase 1: Fix Bugs Critiques (URGENT)

**Fichiers à modifier**:
1. `SessionsPage.tsx`
   - Fix filtre mode
   - Invalider cache au switch
   - Forcer refresh

2. `MonitorPage.tsx`
   - Prioriser diagnostics en Phase 1
   - Augmenter timeout
   - Améliorer WS handlers

3. `PriceChart.tsx`
   - Source unique (agent state)
   - Nettoyer overlaps
   - Synchroniser niveaux

4. `AgentStatePanel.tsx`
   - Diagnostics EN PREMIER
   - Quality score visible
   - Liste checks détaillée

### Phase 2: Alignement Backend/Frontend (IMPORTANT)

**Backend modifications**:
1. Standardiser types (`EntryZone`, `Position`, `Plan`)
2. Ajouter events WS manquants
3. Broadcaster changements critiques

**Frontend modifications**:
1. Créer types TypeScript partagés
2. Valider données API
3. Gérer erreurs gracefully

### Phase 3: Amélioration UX (NICE TO HAVE)

1. **Dashboard Trading** (nouvelle page)
   - Entry zone + rationale (pourquoi cette zone ?)
   - Quality score EN GROS
   - Derniers triggers
   - Position actuelle si existe

2. **Diagnostic Panel** amélioré
   - Checks avec explications détaillées
   - History des checks (voir pourquoi ça a changé)
   - Suggestions d'actions

3. **Chart amélioré**
   - Annotations automatiques (entry, TP1, TP2, stop)
   - Trailing stop history visible
   - Breakout mode indication

---

## 🚀 PLAN D'IMPLÉMENTATION

### Sprint 1 (4h) - Bugs Critiques
- [ ] Fix SessionsPage mode filter
- [ ] Fix MonitorPage diagnostics priority
- [ ] Fix PriceChart levels overlap
- [ ] Fix AgentStatePanel diagnostics visibility

### Sprint 2 (6h) - Backend Alignment
- [ ] Standardiser types backend
- [ ] Ajouter WS events manquants
- [ ] Broadcaster changements état agent
- [ ] Tests E2E backend → frontend

### Sprint 3 (8h) - UX Improvements
- [ ] Dashboard Trading dédié
- [ ] Diagnostic Panel avancé
- [ ] Chart annotations
- [ ] Mobile responsive

---

## 📋 CHECKLIST VALIDATION

### Tests à faire après chaque fix:

**SessionsPage**:
- [ ] Switch Live → Paper → List change instantanée
- [ ] Refresh manuel → Données à jour
- [ ] Cache invalidation → Pas de données obsolètes

**MonitorPage**:
- [ ] Load < 5 secondes pour données critiques
- [ ] Diagnostics visibles immédiatement
- [ ] WS updates → UI réactive

**PriceChart**:
- [ ] Entry zone = agent.plan.zone (exact match)
- [ ] Support/Resistance = status.sr (exact match)
- [ ] Target/Stop = agent.plan levels (exact match)

**AgentStatePanel**:
- [ ] Diagnostics EN PREMIER
- [ ] Quality score progress visible
- [ ] Raison "can't trade" claire

---

## 🎯 RÉSUMÉ EXÉCUTIF

**Bugs Critiques**: 5 identifiés
**Problèmes Alignement**: 2 majeurs
**Effort Total**: ~18 heures
**Impact**: ⭐⭐⭐⭐⭐ CRITIQUE

**Recommandation**: Commencer par Sprint 1 (bugs critiques) IMMÉDIATEMENT, puis Sprint 2 pour alignement backend/frontend.

**Prochaine Étape**: Commencer les fixes ? 🚀
