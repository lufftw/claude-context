// The guard exists so that releasing a large collection actually holds. On the estate this was written for,
// one collection was 70% of all vector data (586,641 rows x 4,096 dims, ~9.6 GB raw); releasing it took the
// Milvus process from 11.96 GiB to 3.42 GiB, and `ensureLoaded()` silently reloaded it on the next search,
// three days after an explicit ruling to keep it released.
//
// So the tests that matter are: off by default, and actually refusing when configured.

jest.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {},
  DataType: {},
  MetricType: {},
  FunctionType: {},
  LoadState: { LoadStateLoaded: 'LoadStateLoaded' },
}));

import {
  isAutoLoadDenied,
  autoLoadDenyPatterns,
  autoLoadDenyMessage,
} from '../autoload-policy';

describe('autoload policy', () => {
  it('denies nothing by default, so existing behaviour is unchanged', () => {
    expect(autoLoadDenyPatterns({})).toEqual([]);
    expect(isAutoLoadDenied('event_shared', {})).toBe(false);
    expect(isAutoLoadDenied('anything_at_all', {})).toBe(false);
    // an empty or whitespace-only setting must also mean "no policy", not "deny everything"
    expect(isAutoLoadDenied('event_shared', { MILVUS_AUTOLOAD_DENY: '' })).toBe(false);
    expect(isAutoLoadDenied('event_shared', { MILVUS_AUTOLOAD_DENY: '   ' })).toBe(false);
  });

  it('denies an exact collection name and leaves its neighbours alone', () => {
    const env = { MILVUS_AUTOLOAD_DENY: 'event_shared' };
    expect(isAutoLoadDenied('event_shared', env)).toBe(true);
    // the 0.6b sibling is a different, far smaller collection and must not be caught by an exact rule
    expect(isAutoLoadDenied('event_shared_0p6b', env)).toBe(false);
    expect(isAutoLoadDenied('event_crawler_own', env)).toBe(false);
  });

  it('accepts several names separated by commas, whitespace or both, and tolerates quotes', () => {
    for (const raw of [
      'event_shared,agent_shared',
      'event_shared agent_shared',
      ' event_shared ,  agent_shared ',
      '"event_shared", \'agent_shared\'',
    ]) {
      const env = { MILVUS_AUTOLOAD_DENY: raw };
      expect(autoLoadDenyPatterns(env)).toEqual(['event_shared', 'agent_shared']);
      expect(isAutoLoadDenied('event_shared', env)).toBe(true);
      expect(isAutoLoadDenied('agent_shared', env)).toBe(true);
      expect(isAutoLoadDenied('event_crawler_own', env)).toBe(false);
    }
  });

  it('supports wildcards in either position', () => {
    expect(isAutoLoadDenied('event_shared', { MILVUS_AUTOLOAD_DENY: '*_shared' })).toBe(true);
    expect(isAutoLoadDenied('agent_shared', { MILVUS_AUTOLOAD_DENY: '*_shared' })).toBe(true);
    expect(isAutoLoadDenied('event_shared_0p6b', { MILVUS_AUTOLOAD_DENY: '*_shared' })).toBe(false);
    expect(isAutoLoadDenied('event_shared_0p6b', { MILVUS_AUTOLOAD_DENY: 'event_*' })).toBe(true);
    expect(isAutoLoadDenied('event_shared_0p6b', { MILVUS_AUTOLOAD_DENY: '*shared*' })).toBe(true);
    expect(isAutoLoadDenied('poi_data_layer_own', { MILVUS_AUTOLOAD_DENY: '*shared*' })).toBe(false);
  });

  it('does not let a name with regex metacharacters match by accident', () => {
    // 'event.shared' must not match 'eventXshared' just because '.' is a regex wildcard
    expect(isAutoLoadDenied('eventXshared', { MILVUS_AUTOLOAD_DENY: 'event.shared' })).toBe(false);
    expect(isAutoLoadDenied('event.shared', { MILVUS_AUTOLOAD_DENY: 'event.shared' })).toBe(true);
  });

  it('explains itself, naming the collection, the rule and the way forward', () => {
    const msg = autoLoadDenyMessage('event_shared', { MILVUS_AUTOLOAD_DENY: '*_shared' });
    expect(msg).toContain('event_shared');
    expect(msg).toContain('*_shared');
    expect(msg).toContain('MILVUS_AUTOLOAD_DENY');
    expect(msg).toContain('collections/load');
  });
});

describe('ensureLoaded honours the policy', () => {
  const ORIGINAL = process.env.MILVUS_AUTOLOAD_DENY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MILVUS_AUTOLOAD_DENY;
    else process.env.MILVUS_AUTOLOAD_DENY = ORIGINAL;
  });

  // Built lazily so the module-level jest.mock above is in place first.
  async function restDb(loadState: string) {
    const { MilvusRestfulVectorDatabase } = await import('../milvus-restful-vectordb');
    const db: any = new MilvusRestfulVectorDatabase({ address: 'http://127.0.0.1:19530' });
    db.initializationPromise = Promise.resolve();
    db.baseUrl = 'http://127.0.0.1:19530/v2/vectordb';
    db.loaded = [];
    db.makeRequest = async (endpoint: string) => {
      if (endpoint === '/collections/get_load_state') return { data: { loadState } };
      throw new Error('unexpected endpoint in test: ' + endpoint);
    };
    db.loadCollection = async (name: string) => { db.loaded.push(name); };
    // the guard must be reached through the real ensureLoaded, so that is deliberately NOT stubbed
    return db;
  }

  it('loads an unloaded collection when no policy is set (the default path)', async () => {
    delete process.env.MILVUS_AUTOLOAD_DENY;
    const db = await restDb('LoadStateNotLoad');
    await db.ensureLoaded('event_shared');
    expect(db.loaded).toEqual(['event_shared']);
  });

  it('refuses to load a denied collection, and says why', async () => {
    process.env.MILVUS_AUTOLOAD_DENY = 'event_shared';
    const db = await restDb('LoadStateNotLoad');
    await expect(db.ensureLoaded('event_shared')).rejects.toThrow(/MILVUS_AUTOLOAD_DENY/);
    expect(db.loaded).toEqual([]);            // the 9.6 GB load did not happen
  });

  it('still serves a denied collection that is already loaded: the policy governs loading, not access', async () => {
    process.env.MILVUS_AUTOLOAD_DENY = 'event_shared';
    const db = await restDb('LoadStateLoaded');
    await expect(db.ensureLoaded('event_shared')).resolves.toBeUndefined();
    expect(db.loaded).toEqual([]);
  });

  it('does not affect other collections while one is denied', async () => {
    process.env.MILVUS_AUTOLOAD_DENY = 'event_shared';
    const db = await restDb('LoadStateNotLoad');
    await db.ensureLoaded('event_crawler_own');
    expect(db.loaded).toEqual(['event_crawler_own']);
  });
});
