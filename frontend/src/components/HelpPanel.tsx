import React from 'react';
import { Card, Typography } from 'antd';

export default function HelpPanel(){
  return (
    <Card title="Guide rapide">
      <Typography.Paragraph>
        - Header: montre le mode (LIVE/PAPER), le symbole et la balance disponible (Free USD).
      </Typography.Paragraph>
      <Typography.Paragraph>
        - Price Chart: graphique en temps réel avec support/résistance et pivots; superpose la stratégie (zone/SL/TP) et la position de l’agent si ouverte.
      </Typography.Paragraph>
      <Typography.Paragraph>
        - Strategy: stratégie du jour (bias, zone d’entrée, SL/TP, validité) et niveaux calculés.
      </Typography.Paragraph>
      <Typography.Paragraph>
        - Analysis: indicateurs et résumé d’analyse (technique + news/sentiment si dispo).
      </Typography.Paragraph>
      <Typography.Paragraph>
        - Agent Controls/State: activer l’agent, proposer/valider un plan, voir l’état (ARMED/MANAGE…), PnL, stop/TP.
      </Typography.Paragraph>
      <Typography.Paragraph>
        - Perf: PnL réalisé/latent, ROI, drawdown, win rate depuis le début de session.
      </Typography.Paragraph>
      <Typography.Paragraph>
        - Triggers: journal des signaux/événements générés par l’agent.
      </Typography.Paragraph>
      <Typography.Paragraph>
        - Orders: entrées et sorties (entry/exit), quantité, prix, notionnel, levier, statut.
      </Typography.Paragraph>
    </Card>
  );
}

