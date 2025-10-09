import { randomUUID } from 'crypto';

type WhereInput = Record<string, any> | undefined;
type OrderByInput = Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>> | undefined;

type ModelName =
  | 'agentSession'
  | 'sessionKpi'
  | 'order'
  | 'fill'
  | 'position'
  | 'marginSnapshot'
  | 'alert'
  | 'strategy'
  | 'adaptiveThreshold'
  | 'decisionMemory'
  | 'triggerLog'
  | 'sentimentSnapshot'
  | 'dailyReport'
  | 'improvementItem'
  | 'aiCall'
  | 'user'
  | 'userApiKey'
  | 'userSetting'
  | 'auditLog';

type ModelStore = Map<ModelName, any[]>;

type CreateArgs = { data: Record<string, any> };
type UpdateArgs = { where: WhereInput; data: Record<string, any> };
type FindUniqueArgs = { where: WhereInput; select?: Record<string, boolean>; include?: Record<string, boolean> };
type FindFirstArgs = {
  where?: WhereInput;
  orderBy?: OrderByInput;
  include?: Record<string, boolean>;
  select?: Record<string, boolean>;
};
type FindManyArgs = {
  where?: WhereInput;
  orderBy?: OrderByInput;
  include?: Record<string, boolean>;
  select?: Record<string, boolean>;
  take?: number;
};
type CountArgs = { where?: WhereInput };
type DeleteArgs = { where?: WhereInput };

type DefaultFactory = () => Record<string, any>;

type IncludeSpec = Record<string, boolean | Record<string, any>> | undefined;

type SelectSpec = Record<string, boolean> | undefined;

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeOrderBy(orderBy: OrderByInput): Array<Record<string, 'asc' | 'desc'>> {
  if (!orderBy) return [];
  if (Array.isArray(orderBy)) return orderBy;
  return [orderBy];
}

function toComparable(value: any): any {
  if (value instanceof Date) return value.getTime();
  return value;
}

function compareValues(a: any, b: any, direction: 'asc' | 'desc'): number {
  const va = toComparable(a);
  const vb = toComparable(b);
  if (va === vb) return 0;
  const dir = direction === 'asc' ? 1 : -1;
  if (va == null) return -1 * dir;
  if (vb == null) return 1 * dir;
  return va > vb ? dir : -dir;
}

function valueMatches(recordValue: any, condition: any): boolean {
  if (condition === undefined) return true;
  if (condition === null) return recordValue == null;
  if (condition instanceof Date) {
    return recordValue instanceof Date
      ? recordValue.getTime() === condition.getTime()
      : toComparable(recordValue) === condition.getTime();
  }
  if (typeof condition !== 'object' || Array.isArray(condition)) {
    if (recordValue instanceof Date && typeof condition === 'string') {
      return recordValue.toISOString() === condition;
    }
    return recordValue === condition;
  }

  if ('equals' in condition) {
    return valueMatches(recordValue, condition.equals);
  }
  if ('in' in condition) {
    const arr = Array.isArray(condition.in) ? condition.in : [];
    return arr.some((item) => valueMatches(recordValue, item));
  }
  if ('notIn' in condition) {
    const arr = Array.isArray(condition.notIn) ? condition.notIn : [];
    return !arr.some((item) => valueMatches(recordValue, item));
  }
  if ('contains' in condition) {
    if (typeof recordValue !== 'string') return false;
    return recordValue.includes(condition.contains);
  }
  if ('startsWith' in condition) {
    if (typeof recordValue !== 'string') return false;
    return recordValue.startsWith(condition.startsWith);
  }
  if ('endsWith' in condition) {
    if (typeof recordValue !== 'string') return false;
    return recordValue.endsWith(condition.endsWith);
  }
  if ('gt' in condition || 'gte' in condition || 'lt' in condition || 'lte' in condition) {
    const numeric = Number(toComparable(recordValue));
    if (!Number.isFinite(numeric)) return false;
    if (condition.gt !== undefined && !(numeric > Number(condition.gt))) return false;
    if (condition.gte !== undefined && !(numeric >= Number(condition.gte))) return false;
    if (condition.lt !== undefined && !(numeric < Number(condition.lt))) return false;
    if (condition.lte !== undefined && !(numeric <= Number(condition.lte))) return false;
    return true;
  }
  if ('not' in condition) {
    return !valueMatches(recordValue, condition.not);
  }

  return Object.entries(condition).every(([key, sub]) =>
    valueMatches(recordValue ? recordValue[key] : undefined, sub)
  );
}

function whereMatches(record: any, where?: WhereInput): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') {
      const arr = Array.isArray(condition) ? condition : [condition];
      return arr.every((item) => whereMatches(record, item));
    }
    if (key === 'OR') {
      const arr = Array.isArray(condition) ? condition : [condition];
      return arr.some((item) => whereMatches(record, item));
    }
    if (key === 'NOT') {
      return !whereMatches(record, condition as WhereInput);
    }
    return valueMatches(record?.[key], condition);
  });
}

function applySelect(record: any, select: SelectSpec): any {
  if (!select) return record;
  const entries = Object.entries(select).filter(([, enabled]) => !!enabled);
  if (!entries.length) return {};
  const out: Record<string, any> = {};
  for (const [key] of entries) {
    out[key] = record[key];
  }
  return out;
}

const MODEL_DEFAULTS: Partial<Record<ModelName, DefaultFactory>> = {
  agentSession: () => ({
    id: randomUUID(),
    startedAt: new Date(),
    stoppedAt: null,
    haltedAt: null,
    haltReason: null,
    profileJson: null,
    planJson: null,
    mode: 'paper',
  }),
  sessionKpi: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    aiCallsTotal: 0,
  }),
  order: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    status: 'filled',
    source: 'agent',
  }),
  fill: () => ({
    id: randomUUID(),
    createdAt: new Date(),
  }),
  position: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    qty: 0,
  }),
  marginSnapshot: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    status: 'ok',
    utilisationPct: 0,
  }),
  alert: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    severity: 'low',
  }),
  strategy: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  adaptiveThreshold: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  decisionMemory: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  triggerLog: () => ({
    id: randomUUID(),
    createdAt: new Date(),
  }),
  sentimentSnapshot: () => ({
    id: randomUUID(),
    createdAt: new Date(),
  }),
  dailyReport: () => ({
    id: randomUUID(),
    createdAt: new Date(),
  }),
  improvementItem: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  aiCall: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  user: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  userApiKey: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  userSetting: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  auditLog: () => ({
    id: randomUUID(),
    createdAt: new Date(),
    action: 'test',
    details: null,
  }),
};

class InMemoryModel {
  private name: ModelName;
  private client: InMemoryPrismaClient;

  constructor(name: ModelName, client: InMemoryPrismaClient) {
    this.name = name;
    this.client = client;
  }

  private store(): any[] {
    return this.client._getStore(this.name);
  }

  private applyDefaults(data: Record<string, any>): Record<string, any> {
    const factory = MODEL_DEFAULTS[this.name];
    if (!factory) return { ...data };
    return { ...factory(), ...data };
  }

  private attachIncludes(record: any, include: IncludeSpec): any {
    if (!include) return record;
    const out = record;
    if (this.name === 'agentSession') {
      if (include.kpi) {
        out.kpi = this.client.sessionKpi.findFirst({ where: { sessionId: record.id } }) ?? null;
      }
      if (include.positions) {
        out.positions = this.client.position.findMany({ where: { sessionId: record.id } });
      }
      if (include.orders) {
        out.orders = this.client.order.findMany({ where: { sessionId: record.id } });
      }
      if (include.fills) {
        out.fills = this.client.fill.findMany({ where: { sessionId: record.id } });
      }
      if (include.alerts) {
        out.alerts = this.client.alert.findMany({ where: { sessionId: record.id } });
      }
      if (include.strategy) {
        out.strategy = this.client.strategy.findMany({ where: { sessionId: record.id } });
      }
    }
    return out;
  }

  async create(args: CreateArgs) {
    const raw = args?.data ? clone(args.data) : {};
    const record = this.applyDefaults(raw);
    const now = new Date();
    if ('createdAt' in record && !(record.createdAt instanceof Date)) record.createdAt = new Date(record.createdAt ?? now);
    if ('updatedAt' in record && !(record.updatedAt instanceof Date)) record.updatedAt = new Date(record.updatedAt ?? now);
    this.store().push(record);
    return clone(record);
  }

  async update(args: UpdateArgs) {
    const data = this.store();
    const idx = data.findIndex((item) => whereMatches(item, args.where));
    if (idx < 0) throw new Error(`${this.name}.update: record not found`);
    const current = data[idx];
    const patch = clone(args.data ?? {});
    Object.assign(current, patch);
    if ('updatedAt' in current) current.updatedAt = new Date();
    return clone(current);
  }

  async updateMany(args: UpdateArgs) {
    const data = this.store();
    let count = 0;
    for (const record of data) {
      if (whereMatches(record, args.where)) {
        Object.assign(record, clone(args.data ?? {}));
        if ('updatedAt' in record) record.updatedAt = new Date();
        count += 1;
      }
    }
    return { count };
  }

  async findUnique(args: FindUniqueArgs) {
    const record = this.store().find((item) => whereMatches(item, args?.where));
    if (!record) return null;
    const base = clone(record);
    const selected = applySelect(base, args?.select) ?? base;
    return clone(this.attachIncludes(selected, args?.include));
  }

  async findFirst(args: FindFirstArgs = {}) {
    const records = await this.findMany({ ...args, take: 1 });
    return records.length ? records[0] : null;
  }

  async findMany(args: FindManyArgs = {}) {
    let results = this.store().filter((item) => whereMatches(item, args.where));
    const orderings = normalizeOrderBy(args.orderBy);
    if (orderings.length) {
      results = results.slice().sort((a, b) => {
        for (const order of orderings) {
          const [[field, direction]] = Object.entries(order);
          const cmp = compareValues(a[field], b[field], direction);
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }
    if (typeof args.take === 'number') {
      results = results.slice(0, Math.max(0, args.take));
    }
    return results.map((record) => {
      const base = clone(record);
      const selected = applySelect(base, args.select) ?? base;
      return clone(this.attachIncludes(selected, args.include));
    });
  }

  async count(args: CountArgs = {}) {
    return this.store().filter((item) => whereMatches(item, args.where)).length;
  }

  async delete(args: DeleteArgs) {
    const data = this.store();
    const idx = data.findIndex((item) => whereMatches(item, args.where));
    if (idx < 0) throw new Error(`${this.name}.delete: record not found`);
    const [removed] = data.splice(idx, 1);
    return clone(removed);
  }
}

export class InMemoryPrismaClient {
  private store: ModelStore;
  agentSession: InMemoryModel;
  sessionKpi: InMemoryModel;
  order: InMemoryModel;
  fill: InMemoryModel;
  position: InMemoryModel;
  alert: InMemoryModel;
  marginSnapshot: InMemoryModel;
  strategy: InMemoryModel;
  adaptiveThreshold: InMemoryModel;
  decisionMemory: InMemoryModel;
  triggerLog: InMemoryModel;
  sentimentSnapshot: InMemoryModel;
  dailyReport: InMemoryModel;
  improvementItem: InMemoryModel;
  aiCall: InMemoryModel;
  user: InMemoryModel;
  userApiKey: InMemoryModel;
  userSetting: InMemoryModel;
  auditLog: InMemoryModel;

  constructor() {
    this.store = new Map();
    this.agentSession = new InMemoryModel('agentSession', this);
    this.sessionKpi = new InMemoryModel('sessionKpi', this);
    this.order = new InMemoryModel('order', this);
    this.fill = new InMemoryModel('fill', this);
    this.position = new InMemoryModel('position', this);
    this.marginSnapshot = new InMemoryModel('marginSnapshot', this);
    this.alert = new InMemoryModel('alert', this);
    this.strategy = new InMemoryModel('strategy', this);
    this.adaptiveThreshold = new InMemoryModel('adaptiveThreshold', this);
    this.decisionMemory = new InMemoryModel('decisionMemory', this);
    this.triggerLog = new InMemoryModel('triggerLog', this);
    this.sentimentSnapshot = new InMemoryModel('sentimentSnapshot', this);
    this.dailyReport = new InMemoryModel('dailyReport', this);
    this.improvementItem = new InMemoryModel('improvementItem', this);
    this.aiCall = new InMemoryModel('aiCall', this);
    this.user = new InMemoryModel('user', this);
    this.userApiKey = new InMemoryModel('userApiKey', this);
    this.userSetting = new InMemoryModel('userSetting', this);
    this.auditLog = new InMemoryModel('auditLog', this);
  }

  _getStore(name: ModelName): any[] {
    const existing = this.store.get(name);
    if (existing) return existing;
    const list: any[] = [];
    this.store.set(name, list);
    return list;
  }

  async $disconnect() {
    return;
  }

  async $reset() {
    this.store.clear();
  }

  async $transaction<T>(operations: Promise<T>[]) {
    const results: T[] = [];
    for (const op of operations) {
      results.push(await op);
    }
    return results;
  }
}

export function createInMemoryPrismaClient() {
  return new InMemoryPrismaClient();
}
