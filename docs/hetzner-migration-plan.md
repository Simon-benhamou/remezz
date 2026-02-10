# Migration Hetzner + Architecture Proxy-Per-User

## Vue d'ensemble

Migration de Railway vers Hetzner Cloud avec isolation IP par utilisateur pour scaler le nombre de users sans risque de ban IP Binance collectif.

---

## 1. Architecture Cible

```
                        ┌─────────────────────────────────────────┐
                        │         Hetzner VPS (CX22/CX32)         │
                        │                                         │
 Frontend (Vercel) ───► │  Nginx (reverse proxy + SSL)            │
                        │    ├── Node.js app (pm2)                │
                        │    └── PostgreSQL                       │
                        │                                         │
                        │  Réseau sortant:                        │
                        │    ├── IP principale: 1.2.3.4           │
                        │    │   └── WS market data (partagé)     │
                        │    │                                    │
                        │    ├── IP user-1: 1.2.3.10              │
                        │    │   └── REST API + WS listenKey      │
                        │    │                                    │
                        │    ├── IP user-2: 1.2.3.11              │
                        │    │   └── REST API + WS listenKey      │
                        │    │                                    │
                        │    └── IP user-N: 1.2.3.XX              │
                        │        └── REST API + WS listenKey      │
                        └─────────────────────────────────────────┘
```

### Ce qui passe par le proxy (IP dédiée du user)
- Toutes les requêtes REST Binance (ordres, fetchBalance, listenKey creation, setLeverage)
- Rate limit: 2400w/min **par user** (isolé)

### Ce qui reste sur l'IP principale (partagé)
- WebSocket market data (klines, tickers, bookTickers) — pas d'auth, pas de rate limit IP
- WebSocket user data streams — le listenKey est créé via REST/proxy, la connexion WS elle-même n'a pas de restriction IP
- Frontend API (dashboard, auth, etc.)
- Base de données PostgreSQL

---

## 2. Spécifications Serveur

### Phase Pilote (1-10 users)

| Composant | Spec | Prix |
|-----------|------|------|
| **Serveur** | Hetzner CX22 — 2 vCPU, 4GB RAM, 40GB SSD | €4.49/mois |
| **IPs supplémentaires** | 10 IPv4 | €10/mois |
| **Backups auto** | Hetzner backup (20% du prix serveur) | €0.90/mois |
| **Total** | | **~€16/mois** |

### Phase Scale (10-50 users)

| Composant | Spec | Prix |
|-----------|------|------|
| **Serveur** | Hetzner CX32 — 4 vCPU, 8GB RAM, 80GB SSD | €8.49/mois |
| **IPs supplémentaires** | 50 IPv4 | €50/mois |
| **Backups auto** | | €1.70/mois |
| **Total** | | **~€60/mois** |

### Phase Scale (50-200 users)

| Composant | Spec | Prix |
|-----------|------|------|
| **Serveur** | Hetzner CX42 — 8 vCPU, 16GB RAM, 160GB SSD | €15.49/mois |
| **IPs supplémentaires** | Pool dynamique | €1/IP/mois |
| **Backup** | | ~€3/mois |
| **Total** | | **€1/user/mois + ~€20 base** |

> Note: Hetzner limite les IPs supplémentaires par serveur. Au-delà de ~16 IPs, il faut soit un serveur dédié, soit utiliser un pool de mini-VPS comme proxies SOCKS5 (CX11 à €3.29/mois chacun, 1 IP incluse).

---

## 3. Composants à Installer sur le Serveur

### Système de base
- Ubuntu 22.04 LTS
- Node.js 20 LTS (via nvm)
- PostgreSQL 16
- Nginx (reverse proxy + SSL)
- pm2 (process manager Node.js)
- certbot (Let's Encrypt SSL)
- Dante ou 3proxy (serveur SOCKS5 local pour le routage IP)

### Stack applicative
- Backend Node.js (port 3001)
- PostgreSQL (port 5432, localhost only)
- Nginx (ports 80/443 → proxy vers 3001)
- SOCKS5 proxy local (ports 10001-100XX, un par IP)

---

## 4. Étapes de Migration

### Étape 1: Créer le serveur Hetzner (~30 min)

1. Créer un compte Hetzner Cloud (hetzner.com/cloud)
2. Créer un serveur CX22 (datacenter: Falkenstein DE ou Helsinki FI)
3. Choisir Ubuntu 22.04
4. Ajouter ta clé SSH
5. Commander les IPs supplémentaires (Cloud Console → Serveur → Networking → Ajouter IP)
6. Activer les backups automatiques

### Étape 2: Setup système (~1h)

```bash
# Connexion
ssh root@<SERVER_IP>

# Mise à jour
apt update && apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# PM2
npm install -g pm2

# PostgreSQL 16
apt install -y postgresql postgresql-contrib
sudo -u postgres createuser quantailabs -P
sudo -u postgres createdb quantailabs -O quantailabs

# Nginx
apt install -y nginx

# Certbot (SSL)
apt install -y certbot python3-certbot-nginx

# Git
apt install -y git
```

### Étape 3: Configurer les IPs supplémentaires (~30 min)

Après avoir commandé les IPs dans Hetzner Cloud Console, elles sont auto-attachées.
Les configurer dans le réseau:

```bash
# Vérifier les IPs assignées
ip addr show

# Si pas auto-configurées, ajouter manuellement dans /etc/netplan/
# (Hetzner Cloud les ajoute généralement automatiquement)
```

Installer un proxy SOCKS5 local (Dante) pour router par IP:

```bash
apt install -y dante-server
```

Config Dante (`/etc/danted.conf`) — un listener par IP:

```
# IP user 1
internal: 127.0.0.1 port = 10001
external: 1.2.3.10  # IP supplémentaire 1

# IP user 2
internal: 127.0.0.1 port = 10002
external: 1.2.3.11  # IP supplémentaire 2

# ... etc

socksmethod: none
clientmethod: none

client pass {
    from: 127.0.0.1/32 to: 0.0.0.0/0
}

socks pass {
    from: 127.0.0.1/32 to: 0.0.0.0/0
}
```

> Alternative plus simple: utiliser `curl --interface <IP>` ou `SO_BINDADDR` directement dans Node.js avec le module `socksv5` ou un agent HTTP custom. Pas besoin de Dante si on route au niveau applicatif.

### Étape 4: Configurer Nginx + SSL (~20 min)

```nginx
# /etc/nginx/sites-available/quantailabs
server {
    listen 80;
    server_name api.quantailabs.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout (agents need long-lived connections)
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/quantailabs /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL
certbot --nginx -d api.quantailabs.com
```

### Étape 5: Déployer l'application (~30 min)

```bash
# Cloner le repo
cd /opt
git clone <REPO_URL> quantailabs
cd quantailabs/backend

# Installer les dépendances
npm ci --production

# Configurer l'environnement
cp .env.example .env
# Éditer .env:
#   DATABASE_URL=postgresql://quantailabs:PASSWORD@localhost:5432/quantailabs
#   JWT_SECRET=<générer avec openssl rand -hex 32>
#   NODE_ENV=production

# Générer Prisma client + push schema
npx prisma generate
npx prisma db push

# Build
npm run build

# Démarrer avec PM2
pm2 start dist/server.js --name quantailabs -i 1
pm2 save
pm2 startup  # Auto-start au reboot
```

### Étape 6: Migrer la base de données (~15 min)

```bash
# Sur Railway: exporter la DB
pg_dump -h <RAILWAY_HOST> -U <USER> -d <DB> -F c -f backup.dump

# Sur Hetzner: importer
pg_restore -h localhost -U quantailabs -d quantailabs backup.dump
```

### Étape 7: Script de déploiement automatique

Créer `/opt/quantailabs/deploy.sh`:

```bash
#!/bin/bash
set -e

cd /opt/quantailabs
echo "📦 Pulling latest code..."
git pull origin main

echo "📦 Installing dependencies..."
cd backend && npm ci --production

echo "🔨 Building..."
npm run build

echo "🗄️ Running migrations..."
npx prisma generate
npx prisma db push --accept-data-loss=false

echo "🔄 Restarting..."
pm2 restart quantailabs

echo "✅ Deployed at $(date)"
```

Usage: `ssh root@server /opt/quantailabs/deploy.sh`

---

## 5. Changements Code Backend

### 5.1 Nouveau fichier: `src/services/userProxyManager.ts`

Gère l'assignation d'une IP proxy par user.

```typescript
// Concept:
// - Table DB: UserProxy (userId, proxyIp, proxyPort, assignedAt)
// - Au premier start d'un user live, assigner une IP du pool
// - Configurer exchange.socksProxy = `socks5://127.0.0.1:{port}`
// - Le user voit l'IP dans ses Settings pour whitelister sur Binance

interface UserProxy {
  userId: string;
  ip: string;        // IP publique sortante (ex: "45.67.89.12")
  socksPort: number;  // Port local Dante/3proxy (ex: 10001)
}

// Pool d'IPs configuré dans .env:
// PROXY_POOL=45.67.89.10:10001,45.67.89.11:10002,45.67.89.12:10003

export function getProxyForUser(userId: string): UserProxy | null { ... }
export function assignProxy(userId: string): UserProxy { ... }
export function releaseProxy(userId: string): void { ... }
export function getUserWhitelistIp(userId: string): string | null { ... }
```

### 5.2 Modifier: `src/server.ts` (création d'exchange)

Quand on crée un exchange CCXT pour un user live, configurer le proxy:

```typescript
// Dans createExchangeForUser() ou équivalent:
const proxy = getProxyForUser(userId);
if (proxy) {
  exchange.socksProxy = `socks5://127.0.0.1:${proxy.socksPort}`;
}
```

### 5.3 Modifier: `src/services/binanceWebSocket.ts`

Le `listenKey` est créé via REST (doit passer par le proxy).
Les requêtes `fetch()` directes dans binanceWebSocket.ts (refreshExchangeSymbols, serverTimeSync)
doivent aussi router via le proxy si elles sont user-specific.

> Note: Les connexions WebSocket elles-mêmes (wss://fstream.binance.com) restent sur l'IP principale — pas de restriction IP sur les WS.

### 5.4 Nouveau endpoint: Settings API

```typescript
// GET /api/user/proxy-ip
// Retourne l'IP que le user doit whitelister sur Binance
app.get("/api/user/proxy-ip", (req, res) => {
  const userId = req.user.id;
  const proxy = getProxyForUser(userId);
  res.json({
    ip: proxy?.ip || SERVER_MAIN_IP,
    instructions: "Add this IP to your Binance API key restrictions"
  });
});
```

### 5.5 Frontend: Settings Page

Ajouter dans la section API Keys:
```
🌐 IP to whitelist on Binance: 45.67.89.12  [📋 Copy]
```

---

## 6. Schema DB (ajout)

```prisma
model UserProxy {
  id         String   @id @default(cuid())
  userId     String   @unique
  user       User     @relation(fields: [userId], references: [id])
  proxyIp    String   // IP publique sortante
  socksPort  Int      // Port local du proxy SOCKS5
  assignedAt DateTime @default(now())
  active     Boolean  @default(true)
}
```

---

## 7. Monitoring & Maintenance

### Health checks
```bash
# Crontab
*/5 * * * * curl -sf http://localhost:3001/api/health || pm2 restart quantailabs
```

### Backup DB automatique
```bash
# Crontab quotidien
0 3 * * * pg_dump -U quantailabs quantailabs | gzip > /backups/db_$(date +\%Y\%m\%d).sql.gz
# Garder 30 jours
0 4 * * * find /backups -name "db_*.sql.gz" -mtime +30 -delete
```

### Logs
```bash
pm2 logs quantailabs          # Logs temps réel
pm2 monit                     # Monitoring CPU/RAM
```

### Mise à jour Node.js / PostgreSQL
```bash
# Mensuel: vérifier les mises à jour de sécurité
apt update && apt upgrade -y
```

---

## 8. Checklist Migration

- [ ] Créer serveur Hetzner CX22
- [ ] Commander IPs supplémentaires (commencer avec 5-10)
- [ ] Setup système (Node.js, PostgreSQL, Nginx, PM2)
- [ ] Configurer IPs + proxy SOCKS5 local
- [ ] SSL via Let's Encrypt
- [ ] Migrer la DB depuis Railway (pg_dump/pg_restore)
- [ ] Déployer l'app
- [ ] Implémenter `userProxyManager.ts`
- [ ] Modifier CCXT exchange creation pour utiliser le proxy
- [ ] Ajouter endpoint `/api/user/proxy-ip`
- [ ] Ajouter affichage IP dans frontend Settings
- [ ] Tester: un user route bien via son IP dédiée
- [ ] Tester: rate limit isolé (un user ne peut pas ban un autre)
- [ ] Couper Railway
- [ ] Mettre à jour DNS si nécessaire

---

## 9. Rollback Plan

Si problème pendant la migration:
1. Railway reste actif jusqu'à validation complète sur Hetzner
2. DNS bascule en ~5 min (TTL court)
3. La DB Railway reste intacte comme backup

---

## 10. Coûts Comparatifs

| Phase | Railway (actuel) | Hetzner (cible) | Économie |
|-------|-----------------|-----------------|----------|
| Pilote (5 users) | ~$40/mois | ~€10/mois | **-75%** |
| Growth (20 users) | ~$50 + $60 proxies | ~€25/mois | **-75%** |
| Scale (50 users) | ~$60 + $150 proxies | ~€60/mois | **-70%** |
| Scale (100 users) | Impossible (1 IP) | ~€110/mois | **possible** |
