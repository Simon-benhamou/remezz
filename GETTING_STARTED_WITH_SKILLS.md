# 🚀 Getting Started with Claude Code Skills

## ✅ Installation Complete!

Vous avez maintenant **5 skills Claude Code** installés et prêts à l'emploi.

---

## 📁 Structure Complète

```
QuantAILabs/
├── .claude/
│   ├── settings.local.json
│   └── skills/
│       ├── README.md (500+ lignes) - Guide principal
│       ├── EXAMPLE_PROMPTS.md (1,100 lignes) - 45 exemples
│       ├── QUICK_REFERENCE.md - Référence rapide
│       ├── STRUCTURE.txt - Vue d'ensemble
│       │
│       ├── backtest-analyzer/
│       │   └── SKILL.md (850 lignes)
│       │
│       ├── code-consistency-checker/
│       │   └── SKILL.md (1,100 lignes)
│       │
│       ├── pattern-researcher/
│       │   └── SKILL.md (1,200+ lignes)
│       │
│       ├── strategy-optimizer/
│       │   └── SKILL.md (1,400+ lignes)
│       │
│       └── ml-signal-scorer/
│           └── SKILL.md (1,300+ lignes)
│
├── SKILLS_IMPLEMENTATION_SUMMARY.md (version initiale, 2 skills)
├── SKILLS_COMPLETE_SUMMARY.md (version complète, 5 skills)
└── GETTING_STARTED_WITH_SKILLS.md (ce fichier)
```

**Total**: ~7,500 lignes de documentation spécialisée

---

## 🎯 3 Étapes pour Démarrer

### Étape 1: Activer les Skills (1 minute)

```bash
# Les skills sont déjà installés dans .claude/skills/
# Il suffit de redémarrer Claude Code

1. Quitter Claude Code complètement (Cmd+Q ou fermer la fenêtre)
2. Rouvrir Claude Code
3. Ouvrir ce projet (QuantAILabs)
```

---

### Étape 2: Vérifier l'Installation (30 secondes)

Demandez à Claude:

```
What skills are available?
```

Vous devriez voir:

```
Available skills:
✓ backtest-analyzer - Analyzes backtest results
✓ code-consistency-checker - Validates code parity
✓ pattern-researcher - Discovers trading patterns
✓ strategy-optimizer - Optimizes parameters
✓ ml-signal-scorer - ML signal scoring
```

---

### Étape 3: Premier Test (2 minutes)

Testez votre premier skill:

```
Check if my backtest and production code are consistent
```

Claude va:
1. Utiliser automatiquement `code-consistency-checker`
2. Comparer `backtestService.ts` et `simpleAgent.ts`
3. Vérifier les imports partagés (`momentumSimple.ts`)
4. Reporter toute divergence
5. Donner un status: ✓ PASS ou ❌ CRITICAL ISSUES

**Si ✓ PASS**: Votre architecture partagée excellente est confirmée!

**Si ❌ ISSUES**: Claude fournira le fix exact avec code snippets

---

## 📚 Documentation par Niveau

### Pour Débutants: Quick Reference

**Fichier**: [.claude/skills/QUICK_REFERENCE.md](.claude/skills/QUICK_REFERENCE.md)

**Contenu**:
- One-line descriptions de chaque skill
- Decision tree: quel skill utiliser?
- Workflows communs
- Troubleshooting

**Temps de lecture**: 5 minutes

**Lire maintenant**: ✓ Recommandé pour tous

---

### Pour Utilisateurs: README

**Fichier**: [.claude/skills/README.md](.claude/skills/README.md)

**Contenu**:
- Vue d'ensemble des 5 skills
- Exemples détaillés d'utilisation
- Workflows complets
- Pro tips

**Temps de lecture**: 15 minutes

**Lire**: Après avoir testé votre premier skill

---

### Pour Power Users: Example Prompts

**Fichier**: [.claude/skills/EXAMPLE_PROMPTS.md](.claude/skills/EXAMPLE_PROMPTS.md)

**Contenu**:
- 45 exemples de prompts ready-to-use
- 4 workflows multi-skills
- Templates réutilisables
- Cas d'usage réels

**Temps de lecture**: 30 minutes (ou parcourir au besoin)

**Utiliser**: Comme référence pendant le travail

---

### Pour Développeurs: Individual Skills

**Fichiers**: [.claude/skills/*/SKILL.md](.claude/skills/*/SKILL.md)

**Contenu**:
- Instructions détaillées étape par étape
- Exemples de code
- Output formats
- Advanced techniques

**Temps de lecture**: 20-30 minutes par skill

**Lire**: Quand vous utilisez un skill spécifique en profondeur

---

### Pour Chefs de Projet: Complete Summary

**Fichier**: [SKILLS_COMPLETE_SUMMARY.md](SKILLS_COMPLETE_SUMMARY.md)

**Contenu**:
- Vue d'ensemble des 5 skills
- Roadmap d'utilisation (4 phases)
- Impact attendu (tableaux de métriques)
- Workflows complets

**Temps de lecture**: 20 minutes

**Lire**: Pour planifier l'adoption des skills

---

## 🎓 Parcours d'Apprentissage Recommandé

### Jour 1: Foundation (30 minutes)

```
1. Lire QUICK_REFERENCE.md (5 min)
2. Tester: "What skills are available?" (1 min)
3. Tester: "Check code consistency" (5 min)
4. Tester: "Analyze the latest backtest results" (10 min)
5. Parcourir EXAMPLE_PROMPTS.md sections 1-26 (10 min)
```

**Objectif**: Comprendre les 2 skills de base (analyzer + checker)

---

### Semaine 1: Exploration (2-3 heures)

```
Jour 2-3: Tester 10 prompts de EXAMPLE_PROMPTS.md
Jour 4-5: Lire README.md section par section
Jour 6-7: Expérimenter avec vos propres prompts
```

**Objectif**: Maîtriser backtest-analyzer et code-consistency-checker

---

### Semaine 2-4: Pattern Research (projet réel)

```
Semaine 2: "Research volume accumulation pattern"
Semaine 3: "Optimize pattern parameters"
Semaine 4: "Deploy and validate"
```

**Objectif**: Développer votre premier pattern avec pattern-researcher

**Skill utilisé**: pattern-researcher + strategy-optimizer

---

### Mois 2: Parameter Optimization (amélioration continue)

```
"Optimize all key parameters with latest 12 months data"
"Test across bull/bear regimes"
"Validate with walk-forward analysis"
"Deploy V5.36"
```

**Objectif**: Optimiser paramètres existants

**Skill utilisé**: strategy-optimizer

---

### Mois 3+: ML Integration (avancé)

```
"Export 2,000+ trades for ML training"
"Train XGBoost model"
"Integrate ML into signal ranker"
"Compare ML vs manual baseline"
"Deploy if +15% improvement"
```

**Objectif**: Ajouter ML pour signal scoring

**Skill utilisé**: ml-signal-scorer

---

## 💡 Top 10 Prompts pour Démarrer

### 1. Validation Initiale
```
Check if my backtest and production code are consistent
```

### 2. Analyse Baseline
```
Analyze the latest backtest results and provide key insights
```

### 3. Comparaison de Versions
```
Compare V5.13 with V5.34 backtest performance
```

### 4. Pattern Discovery
```
Research volume accumulation pattern and test on historical data
```

### 5. Optimization
```
Optimize trailing stop distance parameter (test 0.3% to 1.0%)
```

### 6. Hypothesis Testing
```
Test if multi-timeframe confluence (15m + 1h + 4h) improves win rate
```

### 7. Symbol Analysis
```
Which symbols perform best and which should we remove?
```

### 8. Time-of-Day Patterns
```
Are there specific hours where the strategy performs poorly?
```

### 9. Pre-Deployment Validation
```
I want to deploy V5.35 to production. Validate thoroughly.
```

### 10. Debugging
```
Why does my backtest show +200% but live is -10%?
```

---

## 📊 Mesurer le Succès

### Métriques à Tracker

| Métrique | Baseline | Après Skills | Mesure |
|----------|----------|--------------|--------|
| **Temps analyse backtest** | 30 min | 2 min | Chronométrer |
| **Temps validation code** | 45 min | 3 min | Chronométrer |
| **Itérations/semaine** | 2-3 | 5-7 | Compter |
| **Bugs de déploiement** | Variable | ~0 | Tracker |
| **Win Rate** | 59.9% | 75.8% (objectif) | Backtest |
| **Sharpe Ratio** | 1.52 | 2.21 (objectif) | Backtest |

---

## 🐛 Troubleshooting Rapide

### Problème: "Skills not found"

**Solution**:
```bash
# 1. Vérifier fichiers
ls .claude/skills/*/SKILL.md

# 2. Redémarrer Claude Code
# Quitter complètement et rouvrir

# 3. Vérifier
"What skills are available?"
```

---

### Problème: "Wrong skill triggered"

**Solution**:
```
# Au lieu de:
"Analyze this"  # Ambigu

# Utiliser:
"Use backtest-analyzer to analyze this backtest"  # Explicite
```

---

### Problème: "Output too long"

**Solution**:
```
# Ajouter contrainte:
"Analyze backtest but keep summary under 1 page"
"Give me top 5 insights only"
```

---

## 🎁 Bonus Resources

### Pre-Commit Hook (Automatisation)

Créez `.claude/hooks/pre-commit.sh`:

```bash
#!/bin/bash
echo "🔍 Checking code consistency..."
claude-code ask "Quick code consistency check on changed files"

if [ $? -ne 0 ]; then
  echo "❌ Code consistency check failed!"
  exit 1
fi

echo "✅ Code is consistent. Commit allowed."
```

Activez:
```bash
chmod +x .claude/hooks/pre-commit.sh
```

---

### Aliases (Raccourcis)

Ajoutez à votre `.bashrc` ou `.zshrc`:

```bash
alias analyze-backtest="claude-code ask 'Analyze latest backtest results'"
alias check-consistency="claude-code ask 'Check code consistency'"
alias research-pattern="claude-code ask 'Research'"
```

Usage:
```bash
analyze-backtest  # Au lieu de taper le prompt complet
```

---

## 🤝 Partager avec l'Équipe

### Commit des Skills

```bash
cd /Users/simon-davidbenhamou/Desktop/QuantAILabs

git add .claude/skills/
git add SKILLS_COMPLETE_SUMMARY.md
git add GETTING_STARTED_WITH_SKILLS.md

git commit -m "feat: Add 5 Claude Code skills for trading optimization

Skills added:
- backtest-analyzer: Analyze backtest results
- code-consistency-checker: Validate code parity
- pattern-researcher: Discover trading patterns
- strategy-optimizer: Optimize parameters
- ml-signal-scorer: ML signal scoring

Total: ~7,500 lines of specialized documentation
See GETTING_STARTED_WITH_SKILLS.md for quick start guide"

git push
```

### Onboarding Nouveaux Membres

Envoyez ce fichier (`GETTING_STARTED_WITH_SKILLS.md`) aux nouveaux membres avec:

```
1. Pull the latest code
2. Restart Claude Code
3. Read GETTING_STARTED_WITH_SKILLS.md
4. Try your first skill: "Check code consistency"
```

---

## 📅 Plan d'Action Suggéré

### Cette Semaine

- [ ] Redémarrer Claude Code
- [ ] Vérifier: `"What skills are available?"`
- [ ] Tester: `"Check code consistency"`
- [ ] Tester: `"Analyze latest backtest"`
- [ ] Lire: [QUICK_REFERENCE.md](.claude/skills/QUICK_REFERENCE.md)

### Semaine Prochaine

- [ ] Lire: [README.md](.claude/skills/README.md)
- [ ] Tester 10 prompts de [EXAMPLE_PROMPTS.md](.claude/skills/EXAMPLE_PROMPTS.md)
- [ ] Commencer pattern research: `"Research volume accumulation pattern"`

### Mois Prochain

- [ ] Déployer premier pattern optimisé (V5.35)
- [ ] Optimiser paramètres clés (V5.36)
- [ ] Lire: [SKILLS_COMPLETE_SUMMARY.md](SKILLS_COMPLETE_SUMMARY.md)

### Dans 3 Mois

- [ ] Évaluer si ready pour ML (≥1,000 trades, >55% WR)
- [ ] Si oui: `"Train XGBoost model for signal scoring"`
- [ ] Setup quarterly optimization cycle

---

## 🎉 Vous êtes Prêt !

### Prochaine Action Immédiate

**Redémarrez Claude Code maintenant** et tapez:

```
What skills are available?
```

Puis testez votre premier skill:

```
Check if my backtest and production code are consistent
```

---

## 📞 Support

**Questions sur les skills?**

Demandez à Claude:
```
"How do I use the backtest-analyzer skill?"
"Show me examples for pattern-researcher"
"Explain the difference between strategy-optimizer and pattern-researcher"
```

**Problèmes techniques?**

Consultez:
- [QUICK_REFERENCE.md - Troubleshooting](.claude/skills/QUICK_REFERENCE.md#emergency-troubleshooting)
- [README.md - Troubleshooting](.claude/skills/README.md#troubleshooting)

---

**Bon trading et bonnes optimisations ! 🚀📈**

*Créé le: 2026-01-01*
*Skills: 5 installés et prêts*
*Documentation: ~7,500 lignes*
