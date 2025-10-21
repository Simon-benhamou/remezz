export function formatOpsEventMessage(message?: string) {
  if (!message) return 'Agent Update';
  const normalized = message.replace(/[_\s]+/g, ' ').trim();
  return normalized.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function normalizeOpsEventDetails(details: any): Record<string, any> {
  if (!details) return {};
  if (typeof details === 'string') {
    try {
      const parsed = JSON.parse(details);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, any>;
      }
    } catch {
      return { note: details };
    }
    return { note: details };
  }
  if (Array.isArray(details)) {
    return { reasons: details };
  }
  if (typeof details === 'object') {
    return details as Record<string, any>;
  }
  return { value: details };
}

export function formatOpsEventDetailValue(key: string, value: any, depth = 0): string {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (key === 'usdVolumeMA') return formatUsdVolume(value);
    if (key === 'volumeBaseline') return `${(value * 100).toFixed(1)}%`;
    if (key === 'volumePressure') return `${(value * 100).toFixed(0)}%`;
    if (/ratio/i.test(key)) return `${(value * 100).toFixed(1)}%`;
    if (/pct|percentage/i.test(key)) return `${value.toFixed(2)}%`;
    if (/adx/i.test(key)) return value.toFixed(1);
    if (/score/i.test(key)) return value.toFixed(2);
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'string') {
    return formatOpsEventMessage(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatOpsEventDetailValue(key, item, depth + 1))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([childKey, childValue]) => {
        const label = formatOpsEventMessage(childKey);
        const formatted = formatOpsEventDetailValue(childKey, childValue, depth + 1) || '—';
        return `${label}: ${formatted}`;
      })
      .join(depth === 0 ? ' • ' : ', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function collectOpsEventReasons(details: any): string[] {
  const snippets: string[] = [];
  const seen = new Set<string>();

  const addSnippet = (raw: string) => {
    const collapsed = raw.replace(/[_\s]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!collapsed) return;
    if (collapsed.length > 180) return;
    const formatted = collapsed.replace(/\b\w/g, (ch) => ch.toUpperCase());
    if (seen.has(formatted)) return;
    seen.add(formatted);
    snippets.push(formatted);
  };

  const visit = (value: any, depth = 0) => {
    if (value == null || depth > 4) return;
    if (typeof value === 'string') {
      addSnippet(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, any>;
      const prioritizedKeys = [
        'reason',
        'message',
        'summary',
        'reasons',
        'notes',
        'explanation',
        'status',
        'note',
        'detail',
        'why',
        'cause',
      ];
      for (const key of prioritizedKeys) {
        if (obj[key] != null) visit(obj[key], depth + 1);
      }
      for (const [key, val] of Object.entries(obj)) {
        if (prioritizedKeys.includes(key)) continue;
        visit(val, depth + 1);
      }
      if (typeof obj.code === 'string') addSnippet(obj.code);
      return;
    }
    if (typeof value === 'string') addSnippet(value);
  };

  if (typeof details === 'string') {
    try {
      const parsed = JSON.parse(details);
      visit(parsed);
    } catch {
      addSnippet(details);
    }
  } else {
    visit(details);
  }

  return snippets.slice(0, 5);
}

export function formatUsdVolume(raw: number): string {
  if (!Number.isFinite(raw) || raw <= 0) return '—';
  const units = [
    { limit: 1_000_000_000, suffix: 'B' },
    { limit: 1_000_000, suffix: 'M' },
    { limit: 1_000, suffix: 'K' },
  ];
  for (const unit of units) {
    if (raw >= unit.limit) {
      return `$${(raw / unit.limit).toFixed(1)}${unit.suffix}`;
    }
  }
  return `$${raw.toFixed(0)}`;
}
