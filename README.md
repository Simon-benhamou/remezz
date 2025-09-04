
# Trading Agent IA — v3 (Reactive, Neon-ready, Multi-Symbol)
- **IA** stratégie à l'activation + **ré-analyses** lorsqu'on **approche des niveaux** (S/R) ou lors de **mouvements soudains**.
- **Sélection du meilleur perp** (scoring multi-symboles) + **override** du symbole depuis le front.
- **Sizing USD**, ordres **brackets** (SL/TP obligatoires), **journal** d'ordres.
- **Sessions** & **KPIs** (perf depuis activation).
- **Neon Postgres** via Prisma, **Express/WS**, **React (Vite)**.

## Démarrage rapide (Docker)
```bash
cd backend && cp .env.example .env && cd ..
# Édite backend/.env : APP_API_KEY, EXCHANGE_ID/SYMBOL, DATABASE_URL=postgresql://... (Neon), API keys (exchange/IA)
docker compose up --build
# Front: http://localhost:5173  · API: http://localhost:4000
```

> ⚠️ Ne commite jamais tes clés. Regénère toute clé qui aurait été exposée.
