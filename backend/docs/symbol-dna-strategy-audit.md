# Audit Stratégique V5.146 — ADN des Symboles & Limites Structurelles

**Date**: 4 Mars 2026
**Status**: Conclusions validées par BT 2024 OOS + BT 2025 in-sample
**Priorité**: CRITIQUE — Capital à risque si non adressé

---

## 1. Découverte Clé : La Stratégie est Regime-Dépendante

Notre stratégie V5.146 est un **breakout mean-reversion sur BB + momentum 15m**.
Elle entre sur un BB breakout confirmé (close > BB upper/lower) avec volume + ROC, puis capture le mouvement via trailing progressif.

### Résultats par régime de marché

| Régime | Période | BTC Δ | PnL | WR | DD | Sharpe |
|--------|---------|-------|-----|-----|-----|--------|
| **Range-bound** | 2025 (BTC -6%) | -5.6% | **+$9,782** | 65.4% | 36.0% | 2.39 |
| **Bull trending** | 2024 (BTC +118%) | +118% | **-$1,762** | 55.4% | 94.3% | -2.22 |

### Pourquoi ça échoue en bull run

| Métrique | 2024 (bull) | 2025 (range) | Explication |
|----------|-------------|-------------|-------------|
| Avg gain NFS HIGH | $32/trade | $73/trade | Breakouts captent 2x moins en trending |
| SL count | 141 (23%) | 93 (17%) | 50% plus de SL en trending |
| ATR moyen BTC | 0.370% | 0.303% | Plus de vol = plus de SL touchés |
| Range BTC | 163.5% | 54.8% | Marché directionnel ≠ mean-reversion |
| Mois positifs | 2/12 | ~8/12 | Quasi jamais rentable en trending |

**Mécanisme** : En bull run, les breakouts sont dans le sens du trend mais les retracements sont violents (3-5%), touchant nos SL avant que le trend reprenne. En range, les breakouts mean-revertent proprement vers nos trailing stops.

---

## 2. ADN des Symboles Gagnants vs Perdants

### Nos 9 symboles validés (2025, BT combiné = $86K→$9.8K après filtres)

| Symbole | PnL combiné 2025 | Caractéristique |
|---------|-------------------|-----------------|
| WIF | $17,122 | Meme token, très volatile, mean-reversion forte |
| AVAX | $15,725 | L1 mid-cap, bons volume spikes |
| FET | $14,058 | AI narrative, découplé de BTC |
| ADA | $10,502 | Old L1, oscillations prévisibles |
| STX | $10,145 | Bitcoin L2, vol asymétrique |
| XRP | $5,713 | Haute liquidité mais cycles propres |
| DOT | $5,170 | Interop L0, range bien défini |
| RENDER | $4,179 | GPU/AI, listé Jul 2024 seulement |
| IMX | $3,910 | Gaming L2, faible corrélation BTC |

### Symboles qui ÉCHOUENT avec notre stratégie

| Symbole | Raison d'échec | Profil |
|---------|---------------|--------|
| **BTC** | Trop liquide, BB breakouts faibles, ATR insuffisant | Large-cap, trend-following |
| **ETH** | Trop corrélé à BTC, signaux redondants | Large-cap, suit BTC |
| **SOL** | Trends trop longs, mean-reversion faible | Large-cap trending |
| **SUI** | Même profil que SOL | L1 trending |
| **ARB/UNI** | Signaux simultanés avec WIF/FET → dilution en combined BT | Timing collision |

### Caractéristiques ADN discriminantes (à valider avec script)

| Caractéristique | Gagnants | Perdants |
|----------------|----------|----------|
| **Market Cap** | Mid-cap ($1-10B) | Large-cap ($50B+) |
| **Corrélation BTC** | Modérée (0.4-0.7) | Haute (0.8+) |
| **ATR%** | > 0.35% (volatile) | < 0.30% (lisse) |
| **Mean-reversion rate** | Haute (BB breakouts reversent en <5 candles) | Basse (trends persistent) |
| **Volume spikiness** | Spikes nets et fréquents | Volume lisse et constant |
| **Signal timing** | Complémentaire (pas simultané aux autres) | Redondant (même timing que top symbols) |

**Script prêt mais pas encore exécuté** : `scripts/analyze-symbol-dna.ts` — quantifie chaque feature avec Cohen's d et corrélation Pearson vs PnL. À lancer quand machine disponible.

---

## 3. Risques Identifiés

### 3.1 Risque #1 : Les 9 symboles changent de catégorie
- **WIF** : Token meme à $0.42 en Jan 2024, maintenant $2+. Si market cap grandit → volatilité baisse → sort de notre sweet spot
- **RENDER** : N'existait pas avant Jul 2024. Son profil va évoluer avec la maturité
- **STX** : Dépend de l'écosystème Bitcoin L2, peut devenir trending si narrative forte

### 3.2 Risque #2 : Bull run 2026 détruit le capital
- 2024 (bull +118%) = -$1,762, DD 94.3%
- Si 2026 est un bull run, notre stratégie **perdra de l'argent**
- Les filtres V5.139-146 réduisent les pertes (-$1,762 vs -$1,960 baseline) mais ne les éliminent pas

### 3.3 Risque #3 : Overfitting temporel
- Tous les filtres V5.139-V5.146 ont été développés sur données 2025
- Symbol selection V5.132 optimisée sur 2025
- Regime 15m V5.102 validé sur 2025
- **Aucune validation OOS sur un régime de marché différent n'est positive**

---

## 4. Plan d'Action — 3 Chantiers

### Chantier A : Monitoring ADN Continu (URGENT)

**Objectif** : S'assurer que les 9 symboles actifs matchent toujours les caractéristiques gagnantes.

**Actions** :
1. **Scanner mensuel** : Script automatique qui recalcule les métriques ADN (ATR%, mean-reversion rate, BB touch rate, volume spikiness, corrélation BTC) sur les 30 derniers jours pour chaque symbole actif
2. **Seuils d'alerte** : Si un symbole sort du profil ADN → alerte Telegram + suspension automatique
3. **Scan de nouveaux candidats** : Tester 20+ altcoins mid-cap mensuellement. Si un nouveau symbole matche le profil ADN ET passe un BT combiné 3 mois → ajout candidat
4. **Rotation trimestrielle** : Re-run le BT combiné complet tous les 3 mois. Retirer les symboles sous Sharpe 1.0, ajouter les nouveaux validés

**Métriques à surveiller** :
- ATR% (14 périodes, 15m) — doit rester > seuil
- Mean-reversion rate (% BB breakouts qui reversent en <5 candles) — doit rester > seuil
- Corrélation 30j avec BTC — doit rester < 0.8
- Volume spike CV (coefficient de variation) — doit rester > seuil
- BT rolling 3 mois — Sharpe doit rester > 1.0

### Chantier B : Détecteur de Régime Bull Run (CRITIQUE)

**Objectif** : Détecter quand le marché entre en bull trending et ARRÊTER de trader.

**Signal de bull run** (hypothèses à valider) :
- BTC Δ30j > +20% (mois en forte hausse)
- BTC au-dessus de SMA200 daily avec pente > X%
- ADX daily > 40 (trend très fort)
- Altcoin corrélation cross-sectionnelle > 0.8 (tout monte ensemble)

**Comportement souhaité** :
1. **Détection** : Si ≥2 critères sur 4 → régime "BULL_TRENDING"
2. **Action progressive** :
   - Niveau 1 : Réduire taille des positions de 50%
   - Niveau 2 : Ne prendre que des LONGs (pas de SHORT)
   - Niveau 3 : Arrêter complètement de trader (CASH MODE étendu)
3. **Sortie** : Reprendre quand BTC Δ30j < +10% ET corrélation baisse

**Validation** : Backtester ce détecteur sur 2024 — est-ce qu'il aurait arrêté le trading avant les pertes?

### Chantier C : Stratégie Bull Run Alternative (MOYEN TERME)

**Objectif** : Avoir un deuxième système qui profite des bull runs.

**Options à explorer** :
1. **Trend-following simple** : MA crossover (50/200) sur daily, positions longues uniquement, trailing large (5-10%). Profite des gros moves, pas de mean-reversion
2. **DCA momentum** : Quand bull run détecté, switch en DCA hebdomadaire sur top 3 symbols. Pas de trading actif, juste accumulation
3. **Breakout continuation** : Au lieu de mean-reversion, entrer sur BB breakout et SUIVRE le trend avec trailing très large. Inverse de notre stratégie actuelle

**Priorité** : Le Chantier B (ne pas perdre d'argent en bull run) est PLUS IMPORTANT que le Chantier C (en gagner en bull run). Protéger le capital d'abord.

---

## 5. Résumé Décisionnel

| Question | Réponse |
|----------|---------|
| La stratégie V5.146 marche-t-elle ? | **OUI, en marché range** (2025: +$9,782, Sharpe 2.39) |
| Marche-t-elle en bull run ? | **NON** (2024: -$1,762, Sharpe -2.22) |
| Les filtres V5.139-146 aident-ils ? | **OUI** ($198 de moins de pertes même en 2024) |
| Nos 9 symboles sont-ils stables ? | **INCERTAIN** — WIF/RENDER trop jeunes, profils peuvent changer |
| Que faire maintenant ? | **3 chantiers** : monitoring ADN, détecteur bull, stratégie alternative |

### Priorités immédiates

1. 🔴 **URGENT** : Implémenter le détecteur de régime bull (Chantier B) — c'est la protection du capital
2. 🟡 **IMPORTANT** : Scanner ADN mensuel (Chantier A) — rotation des symboles
3. 🟢 **MOYEN TERME** : Stratégie bull alternative (Chantier C)

---

## 6. Scripts Disponibles

| Script | Status | Usage |
|--------|--------|-------|
| `scripts/analyze-symbol-dna.ts` | Créé, pas encore exécuté (CCXT cassé) | Quantifie features discriminantes des symboles |
| `scripts/bt-2024-oos.ts` | Exécuté, résultats ci-dessus | BT 2024 OOS |
| `scripts/analyze-2024-failure.ts` | Exécuté, résultats ci-dessus | Analyse complète échec 2024 |

---

*Ce document doit être revu et mis à jour après chaque trimestre ou changement de régime majeur.*
