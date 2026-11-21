const { INSTANCE_ID, INSTANCE_HEARTBEAT_TTL_MS, MAX_BUFFERED_AMOUNT } = require('./config');
const redis = require('./redis');

const state = {
  sectionCount: 0,
  sections: new Map(),
};
const operators      = new Set();
const instanceCounts = new Map();

function makeSectionName(id, total) {
  const fourWay = ['Front', 'Rear', 'Left', 'Right'];
  if (total === 4) return fourWay[id - 1];
  if (total === 2) return id === 1 ? 'Left' : 'Right';
  return `Section ${id}`;
}

function resetSections(count) {
  state.sectionCount = count;
  state.sections.clear();
  for (let i = 1; i <= count; i++) {
    state.sections.set(i, {
      id: i,
      name: makeSectionName(i, count),
      clients: new Set(),
      lastColor: '#000000',
    });
  }
}

async function saveSectionsToRedis() {
  const redisData = redis.getRedisData();
  if (!redisData || redisData.status !== 'ready') return;
  try {
    const pipeline = redisData.pipeline();
    pipeline.set('echolink:section_count', String(state.sectionCount));
    pipeline.del('echolink:sections');
    for (const s of state.sections.values()) {
      pipeline.hset('echolink:sections', String(s.id), JSON.stringify({
        id: s.id,
        name: s.name,
        lastColor: s.lastColor,
      }));
    }
    await pipeline.exec();
  } catch (err) {
    console.error('[redis save error]', err.message);
  }
}

async function loadStateFromRedis() {
  const redisData = redis.getRedisData();
  if (!redisData || redisData.status !== 'ready') return;
  try {
    const countStr = await redisData.get('echolink:section_count');
    if (!countStr) return;
    const count = parseInt(countStr, 10);
    if (!count || count < 1) return;
    const sectionsHash = await redisData.hgetall('echolink:sections');
    state.sectionCount = count;
    state.sections.clear();
    for (let i = 1; i <= count; i++) {
      let secData = null;
      if (sectionsHash && sectionsHash[String(i)]) {
        try { secData = JSON.parse(sectionsHash[String(i)]); } catch {}
      }
      state.sections.set(i, {
        id: i,
        name: secData?.name || makeSectionName(i, count),
        clients: new Set(),
        lastColor: secData?.lastColor || '#000000',
      });
    }
    console.log(`[redis] loaded ${count} sections from shared state`);
    sendToOperators({ type: 'sections-ready', count, sections: sectionSummary() });
  } catch (err) {
    console.error('[redis load error]', err.message);
  }
}

function pruneStaleInstances() {
  const now = Date.now();
  let changed = false;
  for (const [id, data] of instanceCounts.entries()) {
    if (id !== INSTANCE_ID && (now - data.lastSeen > INSTANCE_HEARTBEAT_TTL_MS)) {
      instanceCounts.delete(id);
      changed = true;
    }
  }
  return changed;
}

function getLocalCounts() {
  const counts = {};
  for (const s of state.sections.values()) {
    counts[s.id] = s.clients.size;
  }
  return counts;
}

function getGlobalConnectedCount(sectionId) {
  if (!redis.hasRedis()) {
    const sec = state.sections.get(sectionId);
    return sec ? sec.clients.size : 0;
  }
  pruneStaleInstances();
  let total = 0;
  for (const data of instanceCounts.values()) {
    total += ((data.counts && data.counts[sectionId]) || 0);
  }
  return total;
}

function sectionSummary() {
  return Array.from(state.sections.values()).map((s) => ({
    id: s.id,
    name: s.name,
    connected: getGlobalConnectedCount(s.id),
    lastColor: s.lastColor,
  }));
}

function broadcastTelemetry() {
  const localCounts = getLocalCounts();
  instanceCounts.set(INSTANCE_ID, { counts: localCounts, lastSeen: Date.now() });
  if (redis.hasRedis()) {
    const published = redis.publish({
      target: 'telemetry',
      instanceId: INSTANCE_ID,
      counts: localCounts,
      timestamp: Date.now(),
    });
    if (!published) {
      sendToOperators({ type: 'section-update', sections: sectionSummary() });
    }
  } else {
    sendToOperators({ type: 'section-update', sections: sectionSummary() });
  }
}

function deliverLocally(envelope) {
  if (envelope.target === 'operators') {
    sendToOperators(envelope.payload);
  } else if (envelope.target === 'section') {
    const section = state.sections.get(Number(envelope.sectionId));
    if (section && envelope.payload && envelope.payload.type === 'color') {
      section.lastColor = envelope.payload.color;
    }
    sendToSection(envelope.sectionId, envelope.payload);
  } else if (envelope.target === 'allSections') {
    if (envelope.payload && envelope.payload.type === 'color') {
      for (const s of state.sections.values()) s.lastColor = envelope.payload.color;
    }
    for (const id of state.sections.keys()) sendToSection(id, envelope.payload);
  } else if (envelope.target === 'sync-sections') {
    if (envelope.sourceId !== INSTANCE_ID) {
      state.sectionCount = envelope.count;
      state.sections.clear();
      if (Array.isArray(envelope.sections)) {
        for (const s of envelope.sections) {
          state.sections.set(s.id, {
            id: s.id,
            name: s.name,
            clients: new Set(),
            lastColor: s.lastColor || '#000000',
          });
        }
      } else {
        resetSections(envelope.count);
      }
    }
    sendToOperators({ type: 'sections-ready', count: envelope.count, sections: sectionSummary() });
  } else if (envelope.target === 'telemetry') {
    if (envelope.instanceId && envelope.counts) {
      instanceCounts.set(envelope.instanceId, {
        counts: envelope.counts,
        lastSeen: envelope.timestamp || Date.now(),
      });
      sendToOperators({ type: 'section-update', sections: sectionSummary() });
    }
  }
}

function sendToOperators(msg) {
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const op of operators) {
    if (op.readyState === op.OPEN && op.bufferedAmount < MAX_BUFFERED_AMOUNT) {
      op.send(payload);
    }
  }
}

function sendToSection(sectionId, msg) {
  const section = state.sections.get(Number(sectionId));
  if (!section) return;
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of section.clients) {
    if (client.readyState === client.OPEN && client.bufferedAmount < MAX_BUFFERED_AMOUNT) {
      client.send(payload);
    }
  }
}

function broadcastToSection(sectionId, msg) {
  const published = redis.publish({ target: 'section', sectionId, payload: msg });
  if (!published) {
    const section = state.sections.get(Number(sectionId));
    if (section && msg && msg.type === 'color') {
      section.lastColor = msg.color;
    }
    sendToSection(sectionId, msg);
  }
}

function broadcastToAllSections(msg) {
  const published = redis.publish({ target: 'allSections', payload: msg });
  if (!published) {
    if (msg && msg.type === 'color') {
      for (const s of state.sections.values()) s.lastColor = msg.color;
    }
    for (const id of state.sections.keys()) sendToSection(id, msg);
  }
}

function publish(envelope) {
  const published = redis.publish(envelope);
  if (!published) {
    deliverLocally(envelope);
  }
}

module.exports = {
  state,
  operators,
  instanceCounts,
  resetSections,
  saveSectionsToRedis,
  loadStateFromRedis,
  pruneStaleInstances,
  getLocalCounts,
  getGlobalConnectedCount,
  sectionSummary,
  broadcastTelemetry,
  deliverLocally,
  sendToOperators,
  sendToSection,
  broadcastToSection,
  broadcastToAllSections,
  publish,
};

