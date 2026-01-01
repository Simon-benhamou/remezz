# 🎯 Quick Reference - 5 Claude Code Skills

## One-Line Descriptions

| Skill | When to Use | Example Prompt |
|-------|-------------|----------------|
| **backtest-analyzer** 📊 | Analyzing backtest results | `"Analyze latest backtest"` |
| **code-consistency-checker** 🔍 | Validating code parity | `"Check code consistency"` |
| **pattern-researcher** 🧠 | Discovering new patterns | `"Research volume accumulation pattern"` |
| **strategy-optimizer** ⚡ | Optimizing parameters | `"Optimize trailing stop distance"` |
| **ml-signal-scorer** 🤖 | ML signal scoring (advanced) | `"Train XGBoost model"` |

---

## Decision Tree: Which Skill to Use?

```
START: What do you want to do?
│
├─ "Analyze backtest performance"
│  └─> Use: backtest-analyzer
│      Prompt: "Analyze latest backtest results"
│
├─ "Compare two strategy versions"
│  └─> Use: backtest-analyzer
│      Prompt: "Compare V5.13 with V5.34"
│
├─ "Check if backtest matches production"
│  └─> Use: code-consistency-checker
│      Prompt: "Check code consistency"
│
├─ "Debug why live differs from backtest"
│  └─> Use: code-consistency-checker
│      Prompt: "Why does backtest show +200% but live is -10%?"
│
├─ "Test a new trading pattern"
│  └─> Use: pattern-researcher
│      Prompt: "Research multi-timeframe confluence pattern"
│
├─ "Find optimal parameter values"
│  └─> Use: strategy-optimizer
│      Prompt: "Optimize ROC_MIN parameter"
│
├─ "Enhance signal quality with ML"
│  └─> Use: ml-signal-scorer (⚠️ requires ≥1,000 trades, >55% WR)
│      Prompt: "Train XGBoost for signal scoring"
│
└─ "Not sure"
   └─> Ask: "What skills are available and when should I use each?"
```

---

## Common Workflows

### 🔄 Workflow 1: Weekly Performance Check
```
1. "Analyze last week's backtest results"
2. "Check code consistency"
```
Duration: 5 minutes

---

### 🔄 Workflow 2: Deploy New Pattern
```
1. "Research volume accumulation pattern"
2. "Optimize MIN_RISING_CANDLES parameter"
3. "Check code consistency"
4. "Compare V5.35 with V5.34 baseline"
5. Deploy if improvement > 10%
```
Duration: 2-3 weeks

---

### 🔄 Workflow 3: Parameter Optimization
```
1. "Optimize trailing stop distance (0.3% to 1.0%)"
2. "Validate with walk-forward analysis"
3. "Check code consistency after changes"
4. Deploy optimal parameters
```
Duration: 1-2 weeks

---

### 🔄 Workflow 4: Quarterly Review
```
1. "Analyze last 3 months vs backtest predictions"
2. "Research new patterns for identified weaknesses"
3. "Re-optimize all parameters with latest data"
4. "Validate code consistency"
5. Deploy V5.XX
```
Duration: 1 week (automated)

---

## Skill Combinations

### 🎯 Pattern Development Stack
```
pattern-researcher → strategy-optimizer → code-consistency-checker → backtest-analyzer
```
**Use for**: Developing and validating new trading patterns

---

### 🎯 Parameter Tuning Stack
```
backtest-analyzer → strategy-optimizer → code-consistency-checker
```
**Use for**: Finding optimal parameter values

---

### 🎯 Production Deployment Stack
```
code-consistency-checker → backtest-analyzer → Deploy
```
**Use for**: Pre-deployment validation

---

### 🎯 ML Integration Stack
```
backtest-analyzer (validate baseline) → ml-signal-scorer → backtest-analyzer (validate ML) → code-consistency-checker
```
**Use for**: Adding ML to signal scoring

---

## Impact Matrix

| Skill | Time Saved | Complexity | Impact | When |
|-------|-----------|------------|--------|------|
| backtest-analyzer | 30 min/run | Low | High | Always |
| code-consistency-checker | 45 min/check | Low | Critical | Before deploy |
| pattern-researcher | 2-3 weeks | Medium | Very High | Monthly |
| strategy-optimizer | 1-2 weeks | Medium | High | Quarterly |
| ml-signal-scorer | 3-4 weeks | High | Very High | When ready |

---

## Priority Order (Recommended)

### Phase 1 (Week 1-2): **Foundation**
1. code-consistency-checker
2. backtest-analyzer

**Goal**: Validate baseline is solid

---

### Phase 2 (Week 3-4): **Quick Wins**
3. pattern-researcher

**Goal**: +10-15% ROI via patterns

---

### Phase 3 (Week 5-6): **Optimization**
4. strategy-optimizer

**Goal**: +5-10% Sharpe via parameters

---

### Phase 4 (Month 3+): **Advanced**
5. ml-signal-scorer

**Goal**: +15-25% Sharpe via ML

---

## Emergency Troubleshooting

### Problem: Skills not loading
```
Solution:
1. Check files exist: ls .claude/skills/*/SKILL.md
2. Verify YAML frontmatter (no tabs, starts line 1)
3. Restart Claude Code
4. Ask: "What skills are available?"
```

---

### Problem: Wrong skill triggered
```
Solution:
- Be more specific in prompt
- Use skill name: "Use pattern-researcher to..."
- Check skill description in README.md
```

---

### Problem: Skill output too long
```
Solution:
- Add constraint: "...but keep it under 1 page"
- Ask for summary: "Summarize the backtest analysis in 5 bullet points"
```

---

## Quick Links

- **Full Guide**: [README.md](README.md)
- **45 Examples**: [EXAMPLE_PROMPTS.md](EXAMPLE_PROMPTS.md)
- **Complete Summary**: [/SKILLS_COMPLETE_SUMMARY.md](../../SKILLS_COMPLETE_SUMMARY.md)
- **Structure**: [STRUCTURE.txt](STRUCTURE.txt)

---

## First Steps

### Step 1: Verify Installation
```
Ask Claude: "What skills are available?"
```

Expected output: 5 skills listed

---

### Step 2: Test First Skill
```
Ask Claude: "Check if my backtest and production code are consistent"
```

Skill used: code-consistency-checker

---

### Step 3: Explore Examples
```
Open: .claude/skills/EXAMPLE_PROMPTS.md
Try: Any of the 45 examples
```

---

## Cheat Sheet: Prompt Templates

| Task | Prompt Template |
|------|-----------------|
| Analyze backtest | `"Analyze [version] backtest"` |
| Compare versions | `"Compare [v1] with [v2]"` |
| Check consistency | `"Check code consistency"` |
| Research pattern | `"Research [pattern name] pattern"` |
| Optimize param | `"Optimize [param name] parameter"` |
| Test hypothesis | `"Test if [hypothesis]"` |
| Deploy ML | `"Train XGBoost model for signal scoring"` |

---

## Remember

- **Start simple**: backtest-analyzer + code-consistency-checker first
- **Be specific**: Clear prompts = better results
- **Combine skills**: Use multiple skills in sequence for complex tasks
- **Validate always**: Use code-consistency-checker before every deployment
- **Iterate**: Each skill builds on previous results

---

**🚀 Ready to start? Ask Claude: `"What skills are available?"`**
