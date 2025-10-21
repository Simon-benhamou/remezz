const escapeRegExp = (value: string) => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

const BREAKPOINT_LABELS = [
  'Blocked by:',
  'Summary',
  'EntryReady:',
  'Phase:',
  'Bias:',
  'Price:',
  'Zone:',
  'InZone:',
  'BreakoutOk:',
  'ConfirmationOk:',
  'MomentumOk:',
  'QualityOk:',
  'ProfitOk:',
  'LiquidityOk:',
  'AntiWhaleOk:',
  'CircuitOk:',
  'CooldownOk:',
  'RegimeOk:',
  'BiasOk:',
  'Tp1ProfitPct:',
  'MinProfitPct:',
  'Dir:',
  'ActiveBias:',
  'AdaptiveBias:',
  'BiasOverrideReason:',
  'Playbook:',
  'ZoneDiagnostics:',
  'Trigger',
];

export const formatDiagnosticReason = (reason?: string): string => {
  if (!reason) {
    return '';
  }

  const sections: string[] = [];
  const [lead, ...rest] = reason.split(/\s*Key:/);

  if (lead && lead.trim()) {
    sections.push(lead.trim());
  }

  rest.forEach((segment) => {
    const normalized = segment.trim();
    if (!normalized) {
      return;
    }

    const pieces = normalized.split('•').map((piece) => piece.trim()).filter(Boolean);
    if (pieces.length === 0) {
      sections.push(`Key: ${normalized}`);
      return;
    }

    const [first, ...bullets] = pieces;
    const lines = [`Key: ${first}`];
    bullets.forEach((item) => {
      if (item) {
        lines.push(`• ${item}`);
      }
    });
    sections.push(lines.join('\n'));
  });

  let formatted = sections.join('\n');

  BREAKPOINT_LABELS.forEach((label) => {
    const regex = new RegExp(`\\s*${escapeRegExp(label)}`, 'g');
    formatted = formatted.replace(regex, `\n${label}`);
  });

  formatted = formatted.replace(/\n{2,}/g, '\n');

  return formatted.trim();
};

export default formatDiagnosticReason;
