'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseEnabled,
  redactSnapshot,
  publicPauseEvent,
  agentPauseEvent,
  broadcastPauseEvent,
  agentRoom,
} = require('../dist/lib/pauseIdentity');

const SELF = 'A001';
const OTHER = 'A002';

const budget = {
  maxPauses: 3,
  remainingSeconds: 600,
  canStart: true,
  reason: null,
};

const fullStarted = {
  pauseId: 42,
  agent_matricule: SELF,
  nom: 'Dupont',
  prenom: 'Jean',
  agentName: 'Jean Dupont',
  offerCode: 'OFFRE_A',
  startTime: '2026-03-18T09:00:00.000Z',
  allowedSeconds: 600,
  pauseBudget: budget,
};

const fullStopped = {
  pauseId: 42,
  agent_matricule: SELF,
  nom: 'Dupont',
  prenom: 'Jean',
  agentName: 'Jean Dupont',
  offerCode: 'OFFRE_A',
  endTime: '2026-03-18T09:05:00.000Z',
  durationSeconds: 300,
  endReason: 'auto_15m',
  pauseBudget: budget,
};

const snapshot = [
  {
    offer: { id: 1, code: 'OFFRE_A', label: 'Offre A' },
    effectiveQuota: 2,
    blocked: false,
    pauses: [
      {
        id: 1,
        agent_matricule: SELF,
        nom: 'Dupont',
        prenom: 'Jean',
        start_time: '2026-03-18T09:00:00.000Z',
      },
      {
        id: 2,
        agent_matricule: OTHER,
        nom: 'Martin',
        prenom: 'Eve',
        start_time: '2026-03-18T09:01:00.000Z',
      },
    ],
  },
];

const PII = ['nom', 'prenom', 'agentName'];
const PUBLIC_FORBIDDEN = [...PII, 'agent_matricule', 'pauseBudget', 'allowedSeconds'];
const AGENT_FORBIDDEN = [...PII];

function createIoSpy() {
  const calls = [];
  const makeTarget = (op, rooms) => ({
    emit(event, payload) {
      calls.push({ op, rooms, event, payload });
    },
    except(room) {
      return makeTarget('except', rooms.concat(room));
    },
  });
  return {
    calls,
    emit(event, payload) {
      calls.push({ op: 'emit', rooms: [], event, payload });
    },
    to(room) {
      return makeTarget('to', [room]);
    },
    except(room) {
      return makeTarget('except', [room]);
    },
  };
}

describe('parseEnabled', () => {
  it('absent / vide / 0 = off', () => {
    assert.equal(parseEnabled(null), false);
    assert.equal(parseEnabled(''), false);
    assert.equal(parseEnabled('0'), false);
    assert.equal(parseEnabled(undefined), false);
  });

  it("'1' = on", () => {
    assert.equal(parseEnabled('1'), true);
  });
});

describe('redactSnapshot', () => {
  it('sans self : aucune identité', () => {
    const out = redactSnapshot(snapshot);
    assert.equal(out[0].offer.code, 'OFFRE_A');
    assert.equal(out[0].effectiveQuota, 2);
    for (const p of out[0].pauses) {
      assert.deepEqual(Object.keys(p).sort(), ['id', 'start_time']);
      assert.equal(p.nom, undefined);
      assert.equal(p.agent_matricule, undefined);
    }
    assert.equal(snapshot[0].pauses[0].nom, 'Dupont');
  });

  it('avec self : matricule seulement sur sa ligne', () => {
    const out = redactSnapshot(snapshot, SELF);
    const mine = out[0].pauses.find((p) => p.id === 1);
    const theirs = out[0].pauses.find((p) => p.id === 2);
    assert.equal(mine.agent_matricule, SELF);
    assert.equal(mine.nom, undefined);
    assert.equal(mine.prenom, undefined);
    assert.equal(theirs.agent_matricule, undefined);
    assert.equal(theirs.nom, undefined);
    assert.deepEqual(Object.keys(theirs).sort(), ['id', 'start_time']);
  });

  it('entrée non tableau → []', () => {
    assert.deepEqual(redactSnapshot(null), []);
  });
});

describe('publicPauseEvent', () => {
  it('started : pauseId, offre, heure — sans PII ni budget', () => {
    const out = publicPauseEvent(fullStarted);
    assert.deepEqual(out, {
      pauseId: 42,
      offerCode: 'OFFRE_A',
      startTime: fullStarted.startTime,
    });
    for (const key of PUBLIC_FORBIDDEN) {
      assert.equal(Object.prototype.hasOwnProperty.call(out, key), false, key);
    }
  });

  it('stopped : pas de startTime, pas de budget', () => {
    const out = publicPauseEvent(fullStopped);
    assert.deepEqual(out, { pauseId: 42, offerCode: 'OFFRE_A' });
    assert.equal(out.pauseBudget, undefined);
    assert.equal(out.agent_matricule, undefined);
    assert.equal(out.agentName, undefined);
  });
});

describe('agentPauseEvent', () => {
  it('started : matricule + budget + cap, sans noms', () => {
    const out = agentPauseEvent(fullStarted);
    assert.equal(out.pauseId, 42);
    assert.equal(out.offerCode, 'OFFRE_A');
    assert.equal(out.agent_matricule, SELF);
    assert.equal(out.pauseBudget, budget);
    assert.equal(out.allowedSeconds, 600);
    assert.equal(out.startTime, fullStarted.startTime);
    for (const key of AGENT_FORBIDDEN) {
      assert.equal(Object.prototype.hasOwnProperty.call(out, key), false, key);
    }
  });

  it('stopped : budget conservé, noms absents', () => {
    const out = agentPauseEvent(fullStopped);
    assert.equal(out.agent_matricule, SELF);
    assert.equal(out.pauseBudget, budget);
    assert.equal(out.nom, undefined);
    assert.equal(out.prenom, undefined);
    assert.equal(out.agentName, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'startTime'), false);
  });
});

describe('broadcastPauseEvent', () => {
  it('anonymize off : un seul emit full', () => {
    const io = createIoSpy();
    broadcastPauseEvent(io, 'pause:started', fullStarted, false);
    assert.equal(io.calls.length, 1);
    assert.equal(io.calls[0].op, 'emit');
    assert.equal(io.calls[0].payload, fullStarted);
  });

  it('anonymize on : supervisor full, agent filtrée, except public', () => {
    const io = createIoSpy();
    broadcastPauseEvent(io, 'pause:stopped', fullStopped, true);
    const ops = io.calls.map((c) => c.op);
    assert.deepEqual(ops, ['to', 'to', 'except']);

    const sv = io.calls[0];
    assert.deepEqual(sv.rooms, ['supervisor']);
    assert.equal(sv.payload, fullStopped);
    assert.equal(sv.payload.agentName, 'Jean Dupont');

    const me = io.calls[1];
    assert.deepEqual(me.rooms, [agentRoom(SELF)]);
    assert.equal(me.payload.agent_matricule, SELF);
    assert.equal(me.payload.pauseBudget, budget);
    assert.equal(me.payload.agentName, undefined);

    const pub = io.calls[2];
    assert.ok(pub.rooms.includes('supervisor'));
    assert.ok(pub.rooms.includes(agentRoom(SELF)));
    assert.equal(pub.payload.agent_matricule, undefined);
    assert.equal(pub.payload.pauseBudget, undefined);
    assert.equal(pub.payload.pauseId, 42);
  });
});
