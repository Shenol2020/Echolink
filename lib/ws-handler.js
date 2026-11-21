const { INSTANCE_ID } = require('./config');
const {
  state, operators, resetSections, saveSectionsToRedis,
  sectionSummary, broadcastTelemetry, broadcastToSection,
  broadcastToAllSections, publish, sendToOperators,
} = require('./state');
const { subscribeRoom, unsubscribeRoom } = require('./redis');

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'operator-auth': {
      if (ws.isOperator) {
        operators.add(ws);
        subscribeRoom('operators');
        ws.send(JSON.stringify({
          type: 'sections-ready',
          count: state.sectionCount,
          sections: sectionSummary(),
        }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
      }
      break;
    }

    case 'init-sections': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      const count = Math.max(1, Math.min(50, Number(msg.count) || 0));
      resetSections(count);
      saveSectionsToRedis();
      ws.role = 'operator';
      operators.add(ws);
      subscribeRoom('operators');
      publish({ target: 'sync-sections', count, sourceId: INSTANCE_ID, sections: sectionSummary() });
      ws.send(JSON.stringify({ type: 'sections-ready', count, sections: sectionSummary() }));
      break;
    }

    case 'operator-join': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      ws.role = 'operator';
      operators.add(ws);
      subscribeRoom('operators');
      ws.send(JSON.stringify({
        type: 'sections-ready',
        count: state.sectionCount,
        sections: sectionSummary(),
      }));
      break;
    }

    case 'phone-join': {
      const sectionId = Number(msg.sectionId);
      const section = state.sections.get(sectionId);
      if (!section) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown or unconfigured section.' }));
        return;
      }
      if (ws.sectionId != null && ws.sectionId !== sectionId) {
        unsubscribeRoom(`section:${ws.sectionId}`);
      }
      ws.role = 'phone';
      ws.sectionId = sectionId;
      section.clients.add(ws);
      subscribeRoom(`section:${sectionId}`);
      ws.send(JSON.stringify({
        type: 'phone-joined',
        sectionId,
        sectionName: section.name,
        currentColor: section.lastColor,
      }));
      broadcastTelemetry();
      break;
    }

    case 'sync-request': {
      const t2 = Date.now();
      const t3 = Date.now();
      ws.send(JSON.stringify({ type: 'sync-response', t1: msg.t1, t2, t3 }));
      break;
    }

    case 'set-color': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      if (Array.isArray(msg.updates)) {
        for (const { sectionId, color } of msg.updates) {
          if (sectionId === 'all') {
            for (const s of state.sections.values()) s.lastColor = color;
            broadcastToAllSections({ type: 'color', color });
          } else {
            const section = state.sections.get(Number(sectionId));
            if (section) {
              section.lastColor = color;
              broadcastToSection(section.id, { type: 'color', color });
            }
          }
        }
      } else {
        const { sectionId, color } = msg;
        if (sectionId === 'all') {
          for (const s of state.sections.values()) s.lastColor = color;
          broadcastToAllSections({ type: 'color', color });
        } else {
          const section = state.sections.get(Number(sectionId));
          if (section) {
            section.lastColor = color;
            broadcastToSection(section.id, { type: 'color', color });
          }
        }
      }
      saveSectionsToRedis();
      sendToOperators({ type: 'section-update', sections: sectionSummary() });
      break;
    }

    case 'scheduled-command': {
      if (!ws.isOperator) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Operator credentials required.' }));
        return;
      }
      const leadMs = Math.max(100, Math.min(5000, Number(msg.leadMs) || 500));
      const targetTime = Date.now() + leadMs;
      const sectionColors = msg.sectionColors || {};

      const sendTo = (sectionId) => {
        const command = Object.assign({}, msg.command);
        if (sectionColors[sectionId]) {
          command.color = sectionColors[sectionId];
          if (!command.colorA) command.colorA = sectionColors[sectionId];
        }
        broadcastToSection(sectionId, { type: 'scheduled', command, targetTime });
      };

      if (msg.targets === 'all') {
        for (const id of state.sections.keys()) sendTo(id);
      } else if (Array.isArray(msg.targets)) {
        for (const id of msg.targets) sendTo(Number(id));
      }
      break;
    }

    default:
      break;
  }
}

module.exports = { handleMessage };

