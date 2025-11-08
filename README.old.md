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


Logique d’analyse implémentée (statistiques, IA, heuristiques)

La logique de l’agent d’analyse combine plusieurs approches :

Règles heuristiques basées sur l’analyse technique : À partir du snapshot technique évoqué, le système déduit un certain nombre de conditions de marché. Par exemple, la direction de la tendance est estimée via l’écart entre EMA20 et EMA50 (spread EMA) et la force de la tendance via l’ADX
GitHub
GitHub
. De même, des règles sur le RSI indiquent un état de surachat, survente ou des conditions propices à des positions longues/courtes
GitHub
GitHub
. Le code de test diagnostique donne un aperçu clair de ces règles : si le spread EMA20-50 dépasse +1% le marché est jugé fortement haussier, si au contraire il est en dessous de -1% c’est fortement baissier, avec des degrés intermédiaires (modéré/sideways)
GitHub
. Ensuite, l’ADX est utilisé pour qualifier la force (forte si ADX>25)
GitHub
, et l’on ajuste le bias (biais directionnel) de l’agent en conséquence. Ce dernier tient compte aussi de la volatilité (ATR%) : une volatilité trop haute classe le marché comme risqué, incitant l’agent à la prudence
GitHub
. Ces règles sont combinées pour simuler le comportement optimal d’un agent : par exemple, si tendance forte et volatilité modérée, l’agent passe en mode “ARMED” (prêt à trader) avec un biais long ou short selon la tendance; si la tendance est faible ou la volatilité excessive, l’agent reste “IDLE” (en attente)
GitHub
GitHub
. On ajuste ensuite ce comportement par les signaux de RSI (éviter de prendre un long si RSI indique surachat, etc.)
GitHub
 et par le niveau de volatilité (si volatilité très haute, on peut réduire la taille de position même si on trade)
GitHub
. L’ensemble de ces heuristiques constitue un système d’analyse technique expert qui essaye de traduire des indicateurs multiples en décisions de trading prudentes.

Analyse “Intelligente” multi-facteurs (IA) : Au-delà des règles fixes, QuantAILabs intègre une couche d’analyse qualifiée d’intelligente ou “AI-powered”. Cela inclut d’abord un filtre intelligent des opportunités : une fonction dédiée récupère le top 50 cryptos par volume (via WebSocket Binance pour éviter de surcharger l’API REST)
GitHub
GitHub
, puis utilise une méthode rankCryptosWithAI pour classer ces actifs selon l’opportunité de trading sur un horizon 24h
GitHub
. Le résultat est une liste d’opportunités classées (type RankedOpportunity) avec pour chaque symbole un score de confiance (0-1), un type d’opportunité (breakout, reversal, momentum, etc.), une direction recommandée (long/short), et même un ensemble de raisons “AI reasoning” expliquant le classement
GitHub
GitHub
. Comment ce classement est-il établi ? Le code fait appel à des fonctions llmJSON qui interrogent un modèle de langage IA (LLM) en lui fournissant le contexte technique et en demandant un résultat formaté en JSON
GitHub
. Concrètement, deux appels au LLM sont faits dans l’analyse complète : l’un pour estimer le sentiment de marché actuel sur l’actif (bullish, bearish ou neutre avec un score de confiance et quelques justifications)
GitHub
, l’autre pour résumer les nouvelles et narratives récentes susceptibles d’influer sur l’actif (nouvelles macro, ETF, news de développement, etc.)
GitHub
. Ces requêtes peuvent utiliser soit l’API OpenAI (ex: GPT) soit une alternative appelée “Grok” suivant la configuration, avec une mise en cache des résultats pour ne pas sursolliciter le modèle
GitHub
GitHub
. Ainsi, l’agent incorpore une dimension d’actualité et de sentiment en plus des indicateurs purement quantitatifs, ce qui renforce son analyse du contexte.

Apprentissage adaptatif et mémoire : Le système comporte un module de reinforcement learning simplifié. Un composant nommé Adaptive Training recalcule périodiquement (toutes les 15 minutes par défaut) des “poids adaptatifs” associés aux familles de symboles traités
GitHub
GitHub
. Bien que les détails soient cachés (via recomputeAdaptiveWeightsForFamilies), on peut déduire que l’algorithme ajuste certains paramètres de décision en fonction de la performance historique récente des stratégies sur différents groupes d’actifs (familles sectorielles ou types de coins, p. ex. blue-chip vs meme coins). Par ailleurs, un module de mémoire de décision enregistre les décisions prises et leur issue, afin d’alimenter potentiellement l’apprentissage (voir learning/decisionMemory.ts). On voit aussi qu’avant de prendre position, l’agent vérifie des garde-fous de qualité du symbole (ex: volume minimal en USD selon la catégorie de coin, exclusion des coins trop illiquides ou à nom trop complexe)
GitHub
GitHub
, pour éviter des actifs “pièges” – ces règles étant modulées par le niveau d’agressivité de l’agent (conservateur vs agressif) afin d’être plus ou moins strictes
GitHub
GitHub
. Toute cette logique adaptative indique qu’au-delà des règles fixes, l’agent cherche à faire évoluer sa stratégie en continu, en se basant sur l’historique de ses décisions et sur des analyses multi-dimensionnelles (technique + sentiment + qualité de marché).

En somme, le module d’analyse du marché est très sophistiqué : il mêle à la fois des heuristiques de trading bien établies (indicateurs techniques et règles de gestion de risques), des éléments d’intelligence artificielle (LLM pour sentiment/news, scorings automatisés), et des mécanismes d’apprentissage en boucle fermée (réajustement périodique via décisionMemory et adaptive weights). Cette combinaison vise à doter l’agent d’une compréhension riche du marché – non seulement les chiffres bruts, mais aussi le contexte plus global – et à optimiser ses décisions au fil du temps.

Niveau de sophistication de l’agent d’analyse

Compte tenu de ce qui précède, le niveau de sophistication de l’agent est élevé. Contrairement à un simple bot se basant sur un ou deux indicateurs (du type “RSI2 > 70 alors vendre”), QuantAILabs implémente une stratégie multi-critères intégrée. Il évalue la tendance (direction et force), le momentum, la volatilité, la position du prix dans son range, tout en considérant l’aspect actualités/sentiment et la qualité intrinsèque de l’actif. De plus, l’architecture prévoit des ajustements dynamiques : par exemple un Smart Agent peut automatiquement sélectionner le meilleur actif à trader du moment (logique d’auto-selection d’un symbole optimal) et même en changer si une meilleure opportunité apparaît, grâce à la fonction triggerIntelligentReselection qui peut être appelée manuellement ou automatiquement
GitHub
GitHub
. Le statut d’un tel agent “intelligent” conserve l’historique des analyses effectuées, le symbole actuellement suivi, le prochain scan programmé, la dernière raison de changement, etc., pour donner de la transparence sur sa logique
GitHub
GitHub
.

En termes de sophistication algorithmique pure, il ne s’agit pas d’un algo haute fréquence ou mathématiquement très complexe (pas de réseau de neurones profond apparent, ni d’optimisation probabiliste en ligne). Néanmoins, le recours à un LLM pour contextualiser le trading et l’ensemble des règles de trading intègre une forme d’intelligence hybride (ML + règles expertes). On peut dire que c’est un système de trading algorithmique de niveau intermédiaire à avancé, comparable à ce qu’on pourrait attendre d’un assistant trading IA essayant de reproduire les analyses d’un trader humain compétent, tout en automatisant les actions.