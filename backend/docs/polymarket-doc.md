 Doc : Setup Polymarket API                                                 
                                                                             
  Variables d'environnement — uniquement pour les scripts de test            
                                                                             
  Ces 3 variables dans .env ne sont jamais utilisées par le serveur — elles  
  existent seulement pour les scripts scripts/test-pm-*.ts :                 

  POLYMARKET_ACCOUNT_PRIVATE_KEY="0x..."  # clé privée EOA (Magic.link)
  WALLET_ACCOUNT_MAGICLINK="0xC9D58..."   # adresse EOA (dérivée de la clé)
  PROXY_WALLET_ACCOUNT_POLYMARKET="0xd6af1..." # adresse proxy (affichée sur
  polymarket.com)

  Ce qui est configuré via le frontend → stocké en DB

  Le serveur ne lit jamais ces variables .env. Tout passe par SystemSetting
  (chiffré en DB) :

  Clé DB: polymarket_private_key
  Contenu: Clé privée EOA
  Chiffré: ✅
  ────────────────────────────────────────
  Clé DB: polymarket_proxy_address
  Contenu: Adresse proxy 0xd6af1a...
  Chiffré: Non (adresse publique)
  ────────────────────────────────────────
  Clé DB: polymarket_api_key
  Contenu: API key CLOB (dérivée auto)
  Chiffré: ✅
  ────────────────────────────────────────
  Clé DB: polymarket_api_secret
  Contenu: Secret HMAC (dérivé auto)
  Chiffré: ✅
  ────────────────────────────────────────
  Clé DB: polymarket_api_passphrase
  Contenu: Passphrase (dérivée auto)
  Chiffré: ✅
  ────────────────────────────────────────
  Clé DB: polymarket_mode
  Contenu: virtual ou live
  Chiffré: Non
  ────────────────────────────────────────
  Clé DB: polymarket_amount
  Contenu: USDC par pari
  Chiffré: Non

  Flow de configuration (frontend → API)

  Étape 1 — Sauvegarder les credentials :
  PUT /api/polymarket/credentials
  { "privateKey": "0xfd5803...", "proxyAddress": "0xd6af1a..." }
  → Dérive automatiquement les clés API via L1 auth, stocke tout en DB
  chiffré.

  Étape 2 — Valider :
  POST /api/polymarket/validate-credentials
  → Teste L2 HMAC sur /data/orders. Retourne { valid: true, address:
  "0xC9D..." }.

  Étape 3 — Configurer le mode et le montant :
  PUT /api/polymarket/settings
  { "mode": "live", "amount": 5 }
  → Mode live bloqué si pas de credentials.

  Étape 4 — Vérifier la balance :
  GET /api/polymarket/balance
  → Retourne { balance: 77.55 } (lit le proxy via signature_type=1).

  Endpoints worker (bouton STOP)

  GET  /api/polymarket/worker         → { running: true/false }
  POST /api/polymarket/worker/start   → démarre le worker
  POST /api/polymarket/worker/stop    → arrête tout immédiatement

  Résolution automatique

  Les marchés Polymarket 5-min BTC se résolvent on-chain automatiquement —
  aucune action nécessaire. L'ordre FOK (Fill-or-Kill) se remplit
  immédiatement ou s'annule. Les tokens gagnants sont crédités 1 USDC par
  token après résolution du marché. Le bot n'a pas besoin d'intervenir.
