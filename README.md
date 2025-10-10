Algorithme d’IA utilisé par l’agent

L’agent de trading de QuantAILabs n’emploie pas un algorithme de reinforcement learning standard pré-entraîné de type DQN ou PPO. À la place, il s’appuie sur une approche hybride mêlant des règles déterministes basées sur l’analyse technique et des ajustements en temps réel fondés sur les données (ML local adaptatif). Le code qualifie ce système d’« intelligence hybride : ML local + IA ultra-conditionnelle »
GitHub
. Concrètement, cela signifie que l’agent applique une stratégie programmée (logiciel classique) tout en ajustant certains seuils et pondérations de ses indicateurs en fonction des résultats récents, plutôt que de suivre aveuglément un modèle statistique figé. Par exemple, une composante d’auto-apprentissage adaptatif recalcule périodiquement des poids pour les filtres de momentum, volume, volatilité en comparant les caractéristiques des trades gagnants vs perdants sur un historique glissant (environ 200 derniers trades)
GitHub
. Il n’y a donc pas de réseau neuronal profond (pas de LSTM ou CNN entraîné hors-ligne) pilotant directement les décisions, mais une logique algorithmique adaptative renforcée par des analyses « IA » (classement d’opportunités multi-actifs, sentiment de marché, etc.). En résumé, l’agent utilise un algorithme maison orienté règles adaptatives plutôt qu’un modèle type boîte noire entraîné sur données historiques.

Structure de la stratégie de trading (entrées, sorties, SL/TP, fréquence)

La stratégie de trading implémentée est réactive et conçue pour des marchés crypto. L’agent surveille plusieurs paires crypto et ne prend position que lorsque divers critères techniques sont simultanément remplis. Lorsqu’une opportunité est détectée, un ordre bracket est placé, comportant une entrée en position, un stop-loss protecteur et un take-profit dès le départ
GitHub
. Par exemple, dans un cas de trade réel sur BTC/USDT, l’agent a créé un ordre d’achat dès qu’un signal de rebond a été détecté, la transaction s’exécutant au prix du marché, puis un stop-loss a été placé automatiquement environ 1% sous le prix d’entrée pour limiter la perte potentielle
GitHub
. De même, un ou plusieurs objectifs de gain (TP) sont définis – l’agent utilise en effet un système de ladder de take-profit qui permet de prendre des profits partiels à différents paliers. Ces niveaux peuvent être ajustés en cours de trade selon l’évolution des conditions : on observe par exemple que suite à un affaiblissement du momentum après l’entrée, l’agent a resserré le premier TP pour assurer un gain avant que le mouvement ne faiblisse
GitHub
.

Les signaux d’entrée combinent plusieurs indicateurs. Typiquement, l’agent cherche des configurations de retournement ou de cassure confirmées par des indicateurs de tendance et de momentum. Par exemple, un trade sur ETH/USDT a été déclenché dès que le RSI14 est remonté au-dessus d’un seuil (≈48) indiquant une reprise de momentum haussier, tout en respectant les autres filtres – l’ordre d’achat s’est exécuté instantanément et un stop-loss initial d’environ 0,82% sous le point d’entrée a été fixé
GitHub
. D’autres déclencheurs incluent des cassures de range (breakouts) ou des rebonds sur supports, couplés à des confirmations (ex: EMA courtes > EMA longues, volatilité adéquate, volumes en hausse). Une fois en position, l’agent peut sortir soit par atteinte du take-profit, soit par atteinte du stop-loss, soit par invalidation anticipée si les conditions de marché se détériorent (par exemple si un indicateur clé passe en dessous d’un seuil critique, l’agent peut clôturer avant le stop).

La stratégie impose de nombreux garde-fous (filtres) avant de valider une entrée ou pendant la position. Dans les journaux de diagnostics, on voit par exemple les statuts de plusieurs “gates” logiques : un gate momentumOk vérifie que le momentum est suffisant (ex: ADX au-dessus d’un minimum, RSI en zone favorable), un gate volumeOk exige un volume récent adéquat, un gate qualityOk mesure une sorte de score de qualité globale du plan, et un gate profitOk s’assure que le potentiel de gain (distance au TP1) dépasse un minimum par rapport au spread et à la volatilité
GitHub
. Si l’un de ces critères est en échec (FAIL), le trade est bloqué (pas exécuté) ou pourra être clôturé prématurément. Par exemple, dans un des trades étudiés, au moment de la sortie le gate momentumOk est passé à FAIL car l’ADX était retombé < 15, et profitOk était FAIL car le premier objectif de profit était devenu trop faible par rapport aux exigences – l’agent a ainsi constaté que les conditions n’étaient plus réunies pour rester en position
GitHub
.

En termes de gestion du risque et fréquence de trading, l’agent opère avec une taille de position prédéfinie en USD et limite strictement le nombre de trades et pertes consécutives. Par exemple, la configuration par défaut imposait un maximum d’environ 7 trades par jour par agent (gate dailyTradeLimit)
GitHub
. De plus, un coupe-circuit (circuit breaker) stoppe l’ouverture de nouvelles positions après un certain nombre de pertes consécutives – dans les logs, on voit un seuil de 3 pertes d’affilée (gate consecutiveStopsLimit) qui, une fois atteint, devrait suspendre l’agent
GitHub
. Cependant, nous verrons que ce coupe-circuit n’a pas empêché une série de 6 trades perdants consécutifs dans un cas récent, car il ne s’est déclenché qu’après coup et mérite un ajustement. En moyenne, l’agent ne prend donc que quelques trades par jour, uniquement lorsqu’il détecte des configurations à haute probabilité selon ses filtres. S’il manque des opportunités (filtres trop stricts) ou qu’au contraire il trade trop fréquemment en conditions défavorables, cela affectera fortement son taux de réussite.

Données d’entraînement et prétraitement des données de marché

L’agent est conçu pour trader le marché des cryptomonnaies exclusivement. Le code définit en dur une liste d’actifs crypto suivis, par exemple BTC, ETH, SOL, BNB, ADA, AVAX et autres tokens majeurs ou même « meme coins »
GitHub
. Les données de prix et volumes sont récupérées via l’API de l’exchange (Binance via ccxt) en temps réel, soit par WebSocket pour les mises à jour rapides, soit via des appels REST pour les chandeliers historiques. Pour chaque actif, l’agent agrège les données nécessaires afin de calculer une panoplie d’indicateurs techniques sur des horizons pertinents. Parmi ceux utilisés dans la logique backend on retrouve les moyennes mobiles exponentielles (EMA20, EMA50, EMA100, EMA200), le Relative Strength Index (RSI sur 14 périodes), l’Average True Range (ATR pour mesurer la volatilité), l’indicateur de tendance ADX (Average Directional Index) sur 14 périodes, ainsi que des indicateurs de volume et de flux de capitaux (ex: Chaikin Money Flow sur 20 périodes)
GitHub
GitHub
.

Le prétraitement inclut aussi l’identification de niveaux de support et résistance significatifs. Le système calcule régulièrement les supports/résistances récents en détectant les points hauts/bas locaux sur une fenêtre donnée et en les agrégeant (avec une tolérance pour regrouper des niveaux proches)
GitHub
. Il en déduit le support et la résistance les plus proches du prix actuel, ainsi qu’un biais S/R (proche d’un support, d’une résistance ou neutre)
GitHub
. En parallèle, une analyse du régime de marché est effectuée: le code évalue la force de tendance et le biais de fond en comparant par exemple EMA100 vs EMA200 (pour déterminer si le marché est bull, bear ou neutre selon un band de neutralité)
GitHub
. Il calcule aussi un indicateur de force de tendance custom (trendStrength) combinant plusieurs facteurs, et peut estimer la volatilité réalisée sur 15 minutes annualisée
GitHub
. L’ensemble de ces features techniques est compilé dans un snapshot d’état du marché à chaque cycle de décision de l’agent.

Pour ce qui est de l’alignement temporel, l’agent prend soin de n’utiliser que les données disponibles jusqu’à l’instant présent pour éviter tout biais de regard sur le futur. Le système utilise un cache interne mis à jour en continu et dispose de garde-fous de validation: chaque tick de marché entrant est horodaté et vérifié, les données en retard ou incohérentes sont rejetées et éventuellement remplacées par une requête fallback au dernier prix connu
GitHub
. Ainsi, lors des calculs multi-timeframes (par ex. incorporer une tendance H1 dans une décision en M15), l’agent utilise la dernière bougie complète connue de chaque timeframe. Ce souci d’alignement et de qualité des données vise à garantir que l’entraînement en ligne de ses paramètres (et ses décisions) ne soit pas faussé par des informations non disponibles en temps réel. En résumé, les données d’entrée de l’agent sont purement le market data crypto (pas d’autres marchés ni indicateurs macro), soigneusement prétraitées: filtrage des anomalies, calcul des indicateurs techniques standardisés, synchronisation temporelle des différentes échelles, puis enrichissement par des scores ou catégorisations (ex: type de crypto – blue chip vs meme coin – pour adapter les exigences de volume)
GitHub
GitHub
. Toute cette pipeline de données sert de base aux décisions de trading de l’agent.

Suivi des performances et métriques calculées

Plusieurs métriques de performance sont suivies pour évaluer le trading de l’agent. Chaque instance d’agent (session) enregistre ses résultats dans une base de données (table sessionKpi), mise à jour après chaque trade. On y retrouve notamment le nombre de trades effectués, le nombre de gains et de pertes, et des ratios dérivés importants. Le Win Rate (taux de réussite) est calculé simplement comme le pourcentage de trades clôturés en gain sur le total – par exemple si 20 trades sur 50 sont gagnants, le win rate sera 40%
GitHub
. L’expectancy (espérance de gain par trade) est également calculée, correspondant au gain moyen par trade en incluant gains et pertes (elle est positive seulement si la stratégie est profitable en moyenne)
GitHub
. Le système calcule aussi le Profit Factor, défini comme le ratio entre la somme des gains et la somme des pertes (en valeur absolue)
GitHub
. Un profit factor > 1 indique que globalement les gains dépassent les pertes – typiquement on considère >1.5 comme bon, <1 comme insuffisant.

D’autres indicateurs de risque/rentabilité sont suivis: le max drawdown (la baisse maximale en pourcentage du capital par rapport à un pic) est enregistré pour mesurer la pire perte en cours de route. De même, le rapport Sharpe est estimé pour tenir compte de la volatilité des résultats – dans le code il est approché en prenant la moyenne des profits par trade divisée par leur écart-type
GitHub
 (ce qui correspond grossièrement au Sharpe Ratio si on assimile chaque trade à un rendement unitaire, bien que ce calcul ne convertisse pas en rendement annualisé). On retrouve aussi le Calmar Ratio (gain net sur drawdown max) dans les rapports. Le système suit la taille moyenne des gains vs pertes (average win / average loss), le taux de risque-rendement associé, ainsi que les séries de trades (streaks) – par ex. combien de gains consécutifs max, de pertes consécutives max, et la série en cours
GitHub
GitHub
. Toutes ces métriques sont utilisées pour évaluer la santé de la stratégie. Par exemple, le code marque un problème si le win rate < 40% ou si le profit factor < 1.1, en générant des recommandations correspondantes
GitHub
GitHub
. De même, un expectancy négatif ou un grand nombre de pertes consécutives déclenchent des alertes dans l’analyse de performance.

En pratique, les performances observées de l’agent sur la branche principale laissent à désirer : le win rate s’est avéré assez faible (souvent sous 40% gagnants) et de nombreux trades se soldent par des pertes modestes qui s’accumulent. Par exemple, sur une session récente étudiée (9 janvier 2025), l’agent a enchaîné six trades perdants consécutifs sur différents actifs, entraînant une baisse d’environ –1,8% sur le capital
GitHub
. Le profit factor semble être proche ou inférieur à 1 sur certains intervalles, signe que les pertes mangent la majorité des gains. Le ROI mensuel projeté n’était que d’environ +6% avec la configuration initiale malgré un marché offrant des opportunités, ce qui est relativement bas compte tenu du levier possible. Ces métriques décevantes ont motivé une analyse approfondie de la stratégie (score global initial 6,3/10) et la recherche de correctifs pour remonter la performance ciblée (objectif porté à 8,5/10 de score, ROI ~18% mensuel après optimisations)
GitHub
. Nous détaillons ci-dessous les causes identifiées pouvant expliquer ces pertes fréquentes et ce win rate faible, ainsi que les pistes d’amélioration correspondantes.