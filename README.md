
# Trading Agent — v3 (Reactive, Neon-ready, Multi-Symbol)
- AI plan on activation + re-analyses near S/R or on sudden moves.
- Perp ranking (multi-symbol scoring) + frontend override.
- USD sizing, bracket orders (mandatory SL/TP), order journal.
- Sessions & KPIs (performance since activation).
- Neon Postgres via Prisma, Express/WS, React (Vite).

## Quick start (Docker)
```bash
cd backend && cp .env.example .env && cd ..
# Edit backend/.env: APP_API_KEY, EXCHANGE_ID/SYMBOL, DATABASE_URL=postgresql://... (Neon), API keys (exchange/LLM)
docker compose up --build
# Frontend: http://localhost:5173  · API: http://localhost:4000
```

> ⚠️ Never commit your API keys. Rotate any key that might have leaked.
