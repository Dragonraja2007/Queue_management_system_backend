const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory data structure
let lastToken = 0;
const counters = {
  "1": {
    name: "Counter 1",
    currentToken: null,
    queue: [],
    avgServiceTime: 10,
    serviceStartTime: null,
    serviceHistory: []
  },
  "2": {
    name: "Counter 2",
    currentToken: null,
    queue: [],
    avgServiceTime: 5,
    serviceStartTime: null,
    serviceHistory: []
  }
};

// ================================================================
//  Utility: calculate wait time for a token in a counter's queue
// ================================================================
function calculateWaitTime(counterId, token) {
  const counter = counters[counterId];
  if (!counter) return null;

  const idx = counter.queue.findIndex(item => item.token === token);
  if (idx === -1) return null;

  const peopleAhead = idx;
  const waitTime = peopleAhead * counter.avgServiceTime;
  return { peopleAhead, waitTime };
}

// ================================================================
//  GET /api/counters
// ================================================================
app.get('/api/counters', (req, res) => {
  const result = Object.entries(counters).map(([id, counter]) => {
    const queueLength = counter.queue.length;
    const waitTime = queueLength * counter.avgServiceTime;
    return {
      id,
      name: counter.name,
      currentToken: counter.currentToken,
      queueLength,
      waitTime
    };
  });
  res.json(result);
});

// ================================================================
//  POST /api/join
// ================================================================
app.post('/api/join', (req, res) => {
  const { counterId, name } = req.body;

  const counter = counters[counterId];
  if (!counter) {
    return res.status(400).json({ error: 'Invalid counterId' });
  }

  lastToken += 1;
  const token = lastToken;

  counter.queue.push({ token, name });

  const { peopleAhead, waitTime } = calculateWaitTime(counterId, token);

  res.json({
    token,
    position: peopleAhead + 1,
    waitTime
  });
});

// ================================================================
//  GET /api/status/:token
// ================================================================
app.get('/api/status/:token', (req, res) => {
  const token = parseInt(req.params.token, 10);

  // Check 1: is this token currently being served?
  for (const [id, counter] of Object.entries(counters)) {
    if (counter.currentToken === token) {
      return res.json({
        counterId: id,
        currentServing: counter.currentToken,
        yourToken: token,
        peopleAhead: 0,
        status: 'serving'
      });
    }
  }

  // Check 2: is this token still waiting in a queue?
  for (const [id, counter] of Object.entries(counters)) {
    const idx = counter.queue.findIndex(item => item.token === token);
    if (idx !== -1) {
      return res.json({
        counterId: id,
        currentServing: counter.currentToken,
        yourToken: token,
        peopleAhead: idx,
        status: 'waiting'
      });
    }
  }

  // Check 3: token already served — still return currentServing
  // so the frontend can show something meaningful
  const anyServing = Object.entries(counters).find(([, c]) => c.currentToken !== null);
  if (anyServing) {
    return res.status(404).json({
      error: 'Token already served',
      currentServing: anyServing[1].currentToken
    });
  }

  return res.status(404).json({ error: 'Token not found' });
});

// ================================================================
//  POST /api/leave
// ================================================================
app.post('/api/leave', (req, res) => {
  const { token } = req.body;

  if (token === undefined || token === null) {
    return res.status(400).json({ error: 'token is required in request body' });
  }

  const t = parseInt(token, 10);
  if (Number.isNaN(t)) {
    return res.status(400).json({ error: 'token must be a number' });
  }

  for (const [id, counter] of Object.entries(counters)) {
    if (counter.currentToken === t) {
      return res.status(400).json({ error: 'Token is currently being served and cannot leave' });
    }

    const idx = counter.queue.findIndex(item => item.token === t);
    if (idx !== -1) {
      const removed = counter.queue.splice(idx, 1)[0];
      return res.json({
        message: 'Token removed from queue',
        counterId: id,
        token: removed.token,
        remainingQueue: counter.queue.length
      });
    }
  }

  return res.status(404).json({ error: 'Token not found in any queue' });
});

// ================================================================
//  GET /api/stats
// ================================================================
app.get('/api/stats', (req, res) => {
  const stats = Object.entries(counters).map(([id, c]) => ({
    id,
    name: c.name,
    avgServiceTime: c.avgServiceTime,
    totalSessionsRecorded: c.serviceHistory.length,
    sessionHistory: c.serviceHistory.map(t => t.toFixed(1) + ' min')
  }));
  res.json(stats);
});

// ================================================================
//  POST /api/call-next
//  Manual staff override — still works alongside sensor
// ================================================================
app.post('/api/call-next', (req, res) => {
  const { counterId } = req.body;
  const counter = counters[counterId];
  if (!counter) return res.status(400).json({ error: 'Invalid counterId' });

  // Record service time for previous customer if timer was running
  if (counter.serviceStartTime !== null) {
    const durationMs  = Date.now() - counter.serviceStartTime;
    const durationMin = durationMs / 60000;

    counter.serviceHistory.push(durationMin);
    if (counter.serviceHistory.length > 10) counter.serviceHistory.shift();

    const avg = counter.serviceHistory.reduce((a, b) => a + b, 0)
               / counter.serviceHistory.length;
    counter.avgServiceTime = Math.round(avg * 10) / 10;
    console.log(`[Manual] Counter ${counterId} avg updated: ${counter.avgServiceTime} min`);
  }

  if (counter.queue.length === 0) {
    counter.currentToken = null;
    counter.serviceStartTime = null;
    return res.json({ message: 'Queue empty', currentToken: null });
  }

  const next = counter.queue.shift();
  counter.currentToken = next.token;
  counter.serviceStartTime = Date.now();

  res.json({
    currentToken: counter.currentToken,
    name: next.name,
    remainingQueue: counter.queue.length,
    avgServiceTime: counter.avgServiceTime
  });
});

// ================================================================
//  GET /api/slots?time=14:00&date=2025-01-15
// ================================================================
app.get('/api/slots', (req, res) => {
  const { time, date } = req.query;
  if (!time || !date) {
    return res.status(400).json({ error: 'time and date required' });
  }

  const requestedMs = new Date(`${date}T${time}:00`).getTime();
  const nowMs       = Date.now();
  const MIN_GAP_MS  = 20 * 60 * 1000;

  if (requestedMs - nowMs < MIN_GAP_MS) {
    return res.status(400).json({
      error: 'too_soon',
      message: 'Slot must be at least 20 minutes in the future.'
    });
  }

  const avgServiceMs = (() => {
    const allHistories = Object.values(counters).flatMap(c => c.serviceHistory || []);
    if (allHistories.length === 0) {
      const avgMins = Object.values(counters).reduce((sum, c) => sum + c.avgServiceTime, 0)
                    / Object.keys(counters).length;
      return avgMins * 60 * 1000;
    }
    return (allHistories.reduce((a, b) => a + b, 0) / allHistories.length) * 60 * 1000;
  })();

  const slotIntervalMs  = avgServiceMs;
  const currentMaxToken = lastToken;
  const tokensFromNow   = Math.round((requestedMs - nowMs) / slotIntervalMs);
  const targetToken     = currentMaxToken + tokensFromNow;

  const isTokenTaken = (tokenNum) => {
    return Object.values(counters).some(c =>
      c.queue.some(item => item.token === tokenNum) ||
      c.currentToken === tokenNum
    );
  };

  const getBestCounter = (tokenNum) => {
    return Object.entries(counters).reduce((best, [id, c]) => {
      const load = c.queue.filter(item =>
        Math.abs(item.token - tokenNum) <= 5
      ).length;
      const bestLoad = best[1].queue.filter(item =>
        Math.abs(item.token - tokenNum) <= 5
      ).length;
      return load < bestLoad ? [id, c] : best;
    });
  };

  const buildSlot = (tokenNum) => {
    const slotTimeMs  = nowMs + ((tokenNum - currentMaxToken) * slotIntervalMs);
    const slotDate    = new Date(slotTimeMs);
    const hours       = slotDate.getHours().toString().padStart(2, '0');
    const mins        = slotDate.getMinutes().toString().padStart(2, '0');
    const [bestCounterId, bestCounter] = getBestCounter(tokenNum);
    const arrivalDate = new Date(slotTimeMs - 5 * 60 * 1000);
    const arrivalTime = `${arrivalDate.getHours().toString().padStart(2, '0')}:${arrivalDate.getMinutes().toString().padStart(2, '0')}`;

    return {
      token: tokenNum,
      time: `${hours}:${mins}`,
      available: !isTokenTaken(tokenNum),
      counter: bestCounterId,
      counterName: bestCounter.name,
      arrivalTime
    };
  };

  const requestedSlot = buildSlot(targetToken);

  if (requestedSlot.available) {
    return res.json({
      status: 'available',
      slot: requestedSlot,
      avgServiceMins: Math.round(avgServiceMs / 60000)
    });
  }

  const alternatives = [];
  let offset = 1;

  while (alternatives.length < 4 && offset <= 30) {
    const beforeCount = alternatives.filter(s => s.token < targetToken).length;
    const afterCount  = alternatives.filter(s => s.token > targetToken).length;

    if (beforeCount < 2) {
      const before   = buildSlot(targetToken - offset);
      const beforeMs = nowMs + ((before.token - currentMaxToken) * slotIntervalMs);
      if (before.available && beforeMs - nowMs >= MIN_GAP_MS) {
        alternatives.unshift(before);
      }
    }

    if (afterCount < 2) {
      const after = buildSlot(targetToken + offset);
      if (after.available) alternatives.push(after);
    }

    offset++;
  }

  return res.json({
    status: 'taken',
    requested: requestedSlot,
    alternatives,
    avgServiceMins: Math.round(avgServiceMs / 60000)
  });
});

// ================================================================
//  POST /api/join-scheduled
// ================================================================
app.post('/api/join-scheduled', (req, res) => {
  const { name, phone, token, counterId } = req.body;

  if (!name || token === undefined || !counterId) {
    return res.status(400).json({ error: 'name, token, and counterId are required' });
  }

  const counter = counters[counterId];
  if (!counter) {
    return res.status(404).json({ error: 'Counter not found' });
  }

  const alreadyTaken = Object.values(counters).some(c =>
    c.queue.some(item => item.token === token) ||
    c.currentToken === token
  );

  if (alreadyTaken) {
    return res.status(409).json({
      error: 'slot_taken',
      message: 'This slot was just taken by someone else. Please choose another.'
    });
  }

  counter.queue.push({ token, name, phone, scheduled: true });
  counter.queue.sort((a, b) => a.token - b.token);

  if (token > lastToken) lastToken = token;

  const idx      = counter.queue.findIndex(item => item.token === token);
  const waitTime = idx * counter.avgServiceTime;

  res.json({
    token,
    position: idx + 1,
    waitTime,
    counter: counterId,
    counterName: counter.name
  });
});

// ================================================================
//  POST /api/sensor
//  Called by ESP32 when IR sensor detects arrival or departure
// ================================================================
app.post('/api/sensor', (req, res) => {
  const { counterId, event } = req.body;

  if (!counterId || !event) {
    return res.status(400).json({ error: 'counterId and event are required' });
  }

  const counter = counters[counterId];
  if (!counter) {
    return res.status(404).json({ error: 'Counter not found' });
  }

  // ── Person arrived at counter ──
  if (event === 'arrive') {
    if (counter.serviceStartTime === null) {
      counter.serviceStartTime = Date.now();
      console.log(`[Sensor] Counter ${counterId}: person ARRIVED — timer started`);
      return res.json({
        message: 'Timer started',
        counterId,
        currentToken: counter.currentToken
      });
    } else {
      console.log(`[Sensor] Counter ${counterId}: arrive ignored (timer already running)`);
      return res.json({
        message: 'Timer already running',
        counterId,
        currentToken: counter.currentToken
      });
    }
  }

  // ── Person departed from counter ──
  if (event === 'depart') {
    if (counter.serviceStartTime !== null) {
      const durationMs  = Date.now() - counter.serviceStartTime;
      const durationMin = durationMs / 60000;

      // Update rolling average
      counter.serviceHistory.push(durationMin);
      if (counter.serviceHistory.length > 10) counter.serviceHistory.shift();

      const avg = counter.serviceHistory.reduce((a, b) => a + b, 0)
                / counter.serviceHistory.length;
      counter.avgServiceTime = Math.round(avg * 10) / 10;

      console.log(`[Sensor] Counter ${counterId}: person DEPARTED — duration: ${durationMin.toFixed(2)} min, new avg: ${counter.avgServiceTime} min`);

      // Reset timer and clear current token
      counter.serviceStartTime = null;
      counter.currentToken = null;

      // Auto call next token in queue
      if (counter.queue.length > 0) {
        const next = counter.queue.shift();
        counter.currentToken = next.token;
        // serviceStartTime stays null — will be set on next ARRIVE event
        console.log(`[Sensor] Counter ${counterId}: auto-calling token #${next.token}`);

        return res.json({
          message: 'Service recorded, next token called',
          counterId,
          durationMin: durationMin.toFixed(2),
          newAvgServiceTime: counter.avgServiceTime,
          nextToken: next.token,
          remainingQueue: counter.queue.length
        });
      } else {
        console.log(`[Sensor] Counter ${counterId}: queue empty after departure`);
        return res.json({
          message: 'Service recorded, queue empty',
          counterId,
          durationMin: durationMin.toFixed(2),
          newAvgServiceTime: counter.avgServiceTime,
          nextToken: null,
          remainingQueue: 0
        });
      }
    } else {
      console.log(`[Sensor] Counter ${counterId}: depart ignored (no active timer)`);
      return res.json({
        message: 'No active timer to stop',
        counterId
      });
    }
  }

  return res.status(400).json({ error: 'event must be "arrive" or "depart"' });
});

// ================================================================
//  Start server
// ================================================================
app.listen(PORT, () => {
  console.log(`Smart Queue backend listening on port ${PORT}`);
  console.log(`Endpoints ready:`);
  console.log(`  GET  /api/counters`);
  console.log(`  POST /api/join`);
  console.log(`  GET  /api/status/:token`);
  console.log(`  POST /api/leave`);
  console.log(`  GET  /api/stats`);
  console.log(`  POST /api/call-next`);
  console.log(`  GET  /api/slots`);
  console.log(`  POST /api/join-scheduled`);
  console.log(`  POST /api/sensor`);
});