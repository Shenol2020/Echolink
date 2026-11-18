const assert = require('assert');

console.log('--- STARTING REDIS ARCHITECTURE & TLS TEST SUITE ---');
let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passed++;
  } else {
    console.error(`[FAIL] ${message}`);
    failed++;
  }
}

// 1. Test TLS Option Generation Logic
console.log('\n--- 1. Testing Redis TLS Configuration (BUG-11) ---');

function getRedisOptions(url, env = {}) {
  const isTls = url.startsWith('rediss://');
  const options = {
    retryStrategy: (times) => Math.min(times * 150, 3000),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  };
  if (isTls) {
    const rejectUnauthorized = env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
    options.tls = { rejectUnauthorized };
    if (env.REDIS_TLS_SERVERNAME) {
      options.tls.servername = env.REDIS_TLS_SERVERNAME;
    }
  }
  return options;
}

const secureTls = getRedisOptions('rediss://example.redis.cache.windows.net:6380', {});
check(secureTls.tls !== undefined, 'TLS options enabled for rediss:// URL');
check(secureTls.tls.rejectUnauthorized === true, 'rejectUnauthorized defaults to true (SECURE)');

const devTls = getRedisOptions('rediss://localhost:6380', { REDIS_TLS_REJECT_UNAUTHORIZED: 'false' });
check(devTls.tls.rejectUnauthorized === false, 'rejectUnauthorized can be disabled for local dev via REDIS_TLS_REJECT_UNAUTHORIZED=false');

const plainRedis = getRedisOptions('redis://localhost:6379', {});
check(plainRedis.tls === undefined, 'Plain redis:// connection does not attach TLS config');

// 2. Test Multi-Instance Section Synchronization Logic (BUG-03)
console.log('\n--- 2. Testing Multi-Instance State Synchronization (BUG-03) ---');

class MockRedisStorage {
  constructor() {
    this.storage = new Map();
  }
  async get(key) { return this.storage.get(key) || null; }
  async set(key, val) { this.storage.set(key, val); }
  async hset(hash, key, val) {
    if (!this.storage.has(hash)) this.storage.set(hash, new Map());
    this.storage.get(hash).set(key, val);
  }
  async hgetall(hash) {
    const h = this.storage.get(hash);
    if (!h) return {};
    const obj = {};
    for (const [k, v] of h.entries()) obj[k] = v;
    return obj;
  }
}

class MockInstance {
  constructor(id, sharedRedis) {
    this.id = id;
    this.sharedRedis = sharedRedis;
    this.sectionCount = 0;
    this.sections = new Map();
    this.instanceCounts = new Map();
    this.HEARTBEAT_TTL_MS = 15000;
  }

  resetSections(count) {
    this.sectionCount = count;
    this.sections.clear();
    for (let i = 1; i <= count; i++) {
      this.sections.set(i, {
        id: i,
        name: `Section ${i}`,
        clients: new Set(),
        lastColor: '#000000',
      });
    }
  }

  async saveStateToRedis() {
    if (!this.sharedRedis) return;
    await this.sharedRedis.set('echolink:section_count', String(this.sectionCount));
    for (const s of this.sections.values()) {
      await this.sharedRedis.hset('echolink:sections', String(s.id), JSON.stringify({
        id: s.id,
        name: s.name,
        lastColor: s.lastColor,
      }));
    }
  }

  async loadStateFromRedis() {
    if (!this.sharedRedis) return;
    const countStr = await this.sharedRedis.get('echolink:section_count');
    if (!countStr) return;
    const count = parseInt(countStr, 10);
    const sectionsHash = await this.sharedRedis.hgetall('echolink:sections');
    this.sectionCount = count;
    this.sections.clear();
    for (let i = 1; i <= count; i++) {
      let data = null;
      if (sectionsHash[String(i)]) {
        try { data = JSON.parse(sectionsHash[String(i)]); } catch {}
      }
      this.sections.set(i, {
        id: i,
        name: data?.name || `Section ${i}`,
        clients: new Set(),
        lastColor: data?.lastColor || '#000000',
      });
    }
  }

  handleSyncEnvelope(envelope) {
    if (envelope.target === 'sync-sections' && envelope.sourceId !== this.id) {
      this.sectionCount = envelope.count;
      this.sections.clear();
      for (const s of envelope.sections) {
        this.sections.set(s.id, {
          id: s.id,
          name: s.name,
          clients: new Set(),
          lastColor: s.lastColor || '#000000',
        });
      }
    }
  }

  handleTelemetryEnvelope(envelope) {
    if (envelope.target === 'telemetry') {
      this.instanceCounts.set(envelope.instanceId, {
        counts: envelope.counts,
        lastSeen: envelope.timestamp || Date.now(),
      });
    }
  }

  pruneStaleInstances(now = Date.now()) {
    let pruned = false;
    for (const [id, data] of this.instanceCounts.entries()) {
      if (id !== this.id && (now - data.lastSeen > this.HEARTBEAT_TTL_MS)) {
        this.instanceCounts.delete(id);
        pruned = true;
      }
    }
    return pruned;
  }

  getGlobalCount(sectionId) {
    this.pruneStaleInstances();
    let total = 0;
    for (const data of this.instanceCounts.values()) {
      total += ((data.counts && data.counts[sectionId]) || 0);
    }
    return total;
  }
}

async function runRedisTests() {
  const sharedRedis = new MockRedisStorage();
  const instanceA = new MockInstance('instance-A', sharedRedis);
  const instanceB = new MockInstance('instance-B', sharedRedis);

  // Operator initializes 4 sections on Instance A and saves to Redis
  instanceA.resetSections(4);
  await instanceA.saveStateToRedis();

  // Test pub/sub sync
  const syncEnvelope = {
    target: 'sync-sections',
    count: 4,
    sourceId: instanceA.id,
    sections: Array.from(instanceA.sections.values()).map(s => ({ id: s.id, name: s.name, lastColor: s.lastColor })),
  };
  instanceB.handleSyncEnvelope(syncEnvelope);

  check(instanceB.sectionCount === 4, 'Instance B synchronized section count (4)');
  check(instanceB.sections.size === 4, 'Instance B initialized all 4 sections in memory');
  check(instanceB.sections.has(1) && instanceB.sections.has(4), 'Sections 1 through 4 exist on Instance B');

  // Test startup / reconnection state loading from Redis on new Instance C
  const instanceC = new MockInstance('instance-C', sharedRedis);
  await instanceC.loadStateFromRedis();
  check(instanceC.sectionCount === 4, 'Instance C loaded 4 sections from Redis on startup/reconnect');
  check(instanceC.sections.size === 4, 'Instance C restored sections from shared storage without pub/sub');

  // 3. Test Global Device Counting and Heartbeat Expiration (BUG-04)
  console.log('\n--- 3. Testing Global Telemetry & Stale Heartbeat Expiration (BUG-04) ---');

  const now = Date.now();
  const countsA = { 1: 12, 2: 8 };
  instanceA.instanceCounts.set(instanceA.id, { counts: countsA, lastSeen: now });

  const countsB = { 1: 15, 2: 10 };
  instanceB.instanceCounts.set(instanceB.id, { counts: countsB, lastSeen: now });

  // Broadcast telemetry envelopes
  instanceA.handleTelemetryEnvelope({ target: 'telemetry', instanceId: instanceB.id, counts: countsB, timestamp: now });
  instanceB.handleTelemetryEnvelope({ target: 'telemetry', instanceId: instanceA.id, counts: countsA, timestamp: now });

  check(instanceA.getGlobalCount(1) === 27, 'Instance A displays accurate global count for Section 1 (12 + 15 = 27)');
  check(instanceB.getGlobalCount(1) === 27, 'Instance B displays accurate global count for Section 1 (12 + 15 = 27)');

  // Test Stale Instance Expiration: Instance B stops heartbeating and crashes
  const futureTime = now + 16000; // 16 seconds later (exceeds 15s TTL)
  const pruned = instanceA.pruneStaleInstances(futureTime);
  check(pruned === true, 'PruneStaleInstances detected expired heartbeat from crashed Instance B');
  check(instanceA.instanceCounts.has('instance-B') === false, 'Stale Instance B purged from active telemetry map');
  check(instanceA.getGlobalCount(1) === 12, 'Global count accurately falls back to local count after crashed instance expiration');

  console.log('\n========================================');
  console.log(`REDIS SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

runRedisTests();
