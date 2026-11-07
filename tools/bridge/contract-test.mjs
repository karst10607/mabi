import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(import.meta.url);
const { TOOL_NAMES } = require(join(root, 'daemon', 'mcp-server.js'));
const schema = JSON.parse(readFileSync(join(here, 'protocol.schema.json'), 'utf8'));
const doc = readFileSync(join(root, 'docs', 'ws-protocol.md'), 'utf8');
const preload = readFileSync(join(root, 'preload.js'), 'utf8');

const reject = (code, message) => ({ ok: false, error: { code, message } });
const accept = (form, type, extra = {}) => ({ ok: true, form, type, ...extra });
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateFields(value, spec, path) {
  if (!isPlainObject(value)) return reject('bad-field', `${path} must be an object`);
  for (const name of spec.required ?? []) {
    if (!Object.hasOwn(value, name)) return reject('missing-field', `${path}.${name} is required`);
  }
  for (const [name, fieldSpec] of Object.entries(spec.fields ?? {})) {
    if (!Object.hasOwn(value, name)) continue;
    const error = validateValue(value[name], fieldSpec, `${path}.${name}`);
    if (error) return error;
  }
  return null;
}

function validateValue(value, spec, path) {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return reject('bad-field', `${path} must be a string`);
      if (spec.minLength !== undefined && value.length < spec.minLength) {
        return reject('bad-field', `${path} must be at least ${spec.minLength} chars`);
      }
      if (spec.enum && !spec.enum.includes(value)) {
        return reject('bad-field', `${path} must be one of ${spec.enum.join('|')}`);
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
        return reject('bad-field', `${path} must match ${spec.pattern}`);
      }
      return null;
    case 'integer':
      if (!Number.isInteger(value)) return reject('bad-field', `${path} must be an integer`);
      if (spec.minimum !== undefined && value < spec.minimum) {
        return reject('bad-field', `${path} must be >= ${spec.minimum}`);
      }
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return reject('bad-field', `${path} must be a finite number`);
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        return reject('bad-field', `${path} must be >= ${spec.minimum}`);
      }
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : reject('bad-field', `${path} must be a boolean`);
    case 'object':
      return validateFields(value, spec, path);
    case 'array':
      if (!Array.isArray(value)) return reject('bad-field', `${path} must be an array`);
      if (!spec.items) return null;
      for (let i = 0; i < value.length; i += 1) {
        const error = validateValue(value[i], spec.items, `${path}[${i}]`);
        if (error) return error;
      }
      return null;
    default:
      return reject('bad-schema', `${path} has unknown type ${spec.type}`);
  }
}

function validateMessage(msg, { replyFor } = {}) {
  if (!isPlainObject(msg)) return reject('bad-envelope', 'message must be an object');
  if (msg.v !== schema.envelope.version) {
    return reject('bad-envelope', `v must be ${schema.envelope.version}`);
  }

  const hasId = Object.hasOwn(msg, 'id');
  const hasOk = Object.hasOwn(msg, 'ok');

  if (hasId) {
    const idError = validateValue(msg.id, { type: 'integer', minimum: 1 }, 'id');
    if (idError) return idError;

    if (!hasOk) {
      if (typeof msg.t !== 'string') return reject('bad-envelope', 'request requires t');
      const def = schema.messages[msg.t];
      if (!def) return reject('unknown-type', `unknown request type ${msg.t}`);
      if (!def.forms.includes('request')) return reject('bad-form', `${msg.t} does not accept request`);
      const error = validateFields(msg, def, msg.t);
      return error ?? accept('request', msg.t);
    }

    if (typeof msg.ok !== 'boolean') return reject('bad-envelope', 'ok must be a boolean');

    if (msg.ok === false) {
      if (!Object.hasOwn(msg, 'error')) return reject('bad-error', 'failed reply requires error');
      const error = validateFields(msg.error, schema.envelope.error, 'error');
      return error ?? accept('reply', replyFor ?? null);
    }

    if (replyFor !== undefined) {
      const def = schema.messages[replyFor];
      if (!def) return reject('bad-schema', `unknown reply type ${replyFor}`);
      if (!def.reply && !def.forms.includes('reply')) {
        return reject('bad-form', `${replyFor} declares no reply contract`);
      }
      const error = validateFields(msg, def.reply ?? { required: [] }, `${replyFor} reply`);
      if (error) return error;
    }
    return accept('reply', replyFor ?? null);
  }

  if (hasOk) return reject('bad-envelope', 'ok requires id');
  if (typeof msg.t !== 'string') return reject('bad-envelope', 'event requires t');

  const def = schema.messages[msg.t];
  if (!def) return accept('event', msg.t, { ignored: true });
  if (!def.forms.includes('event')) return reject('bad-form', `${msg.t} does not accept event`);
  const error = validateFields(msg, def, msg.t);
  return error ?? accept('event', msg.t);
}

const req = (id, t, extra = {}) => ({ v: 1, id, t, ...extra });
const evt = (t, extra = {}) => ({ v: 1, t, ...extra });
const rep = (id, extra = {}) => ({ v: 1, id, ok: true, ...extra });

const fixtures = {
  hello: [
    { form: 'request', msg: req(1, 'hello', { role: 'body', name: 'godot-body', version: '0.0.1', protocol: 1, token: 'local-token' }) },
  ],
  'hello-ack': [
    { form: 'reply', replyFor: 'hello-ack', msg: rep(1, { session: 'sess-1', protocol: 1, brainVersion: '1.5.2' }) },
  ],
  'state.sync': [
    {
      form: 'event',
      msg: evt('state.sync', {
        mode: 'pet',
        posture: 'sit',
        skin: 'cat',
        nickname: 'Aura',
        roamEnabled: true,
        visibility: true,
        clickThrough: false,
        alwaysOnTop: true,
      }),
    },
  ],
  ping: [{ form: 'event', msg: evt('ping', { ts: 1700000000000 }) }],
  pong: [{ form: 'event', msg: evt('pong', { ts: 1700000000000 }) }],
  bye: [{ form: 'event', msg: evt('bye', { reason: 'shutdown' }) }],
  'mode.request': [{ form: 'request', msg: req(2, 'mode.request', { mode: 'chat' }) }],
  'mode.toggle': [{ form: 'event', msg: evt('mode.toggle') }],
  'mode.set': [{ form: 'event', msg: evt('mode.set', { mode: 'pet' }) }],
  'mode.changed': [{ form: 'event', msg: evt('mode.changed', { mode: 'chat' }) }],
  'window.set': [{ form: 'request', msg: req(3, 'window.set', { alwaysOnTop: true, clickThrough: false, forward: true, visible: true }) }],
  'window.apply': [{ form: 'event', msg: evt('window.apply', { alwaysOnTop: true, clickThrough: false, forward: true, visible: true }) }],
  'window.state': [{ form: 'event', msg: evt('window.state', { alwaysOnTop: true, clickThrough: false, visible: true, x: 100, y: 200 }) }],
  'window.minimize': [{ form: 'event', msg: evt('window.minimize') }],
  'window.close': [{ form: 'event', msg: evt('window.close') }],
  'roam.get': [
    { form: 'request', msg: req(4, 'roam.get') },
    { form: 'reply', replyFor: 'roam.get', msg: rep(4, { enabled: true }) },
  ],
  'roam.set-enabled': [{ form: 'event', msg: evt('roam.set-enabled', { enabled: true }) }],
  'roam.enabled': [{ form: 'event', msg: evt('roam.enabled', { enabled: false }) }],
  'roam.command': [{ form: 'event', msg: evt('roam.command', { action: 'start', dir: 'right', target: { x: 200, y: 100 } }) }],
  'roam.state': [{ form: 'event', msg: evt('roam.state', { state: 'walk-right', x: 101, y: 200 }) }],
  interaction: [{ form: 'event', msg: evt('interaction', { kind: 'pat', source: 'tray' }) }],
  activity: [{ form: 'event', msg: evt('activity') }],
  react: [{ form: 'event', msg: evt('react', { kind: 'pat', emotion: 'happy' }) }],
  say: [{ form: 'event', msg: evt('say', { text: '喵～', emotion: 'happy', ttlMs: 4000, speech: true }) }],
  'pose.set': [{ form: 'event', msg: evt('pose.set', { posture: 'walk', skin: 'walk' }) }],
  'sound.play': [{ form: 'event', msg: evt('sound.play', { clip: 'pat' }) }],
  'ui.busy': [{ form: 'event', msg: evt('ui.busy', { busy: true }) }],
  'chat.send': [{ form: 'event', msg: evt('chat.send', { text: 'hi' }) }],
  'chat.delta': [{ form: 'event', msg: evt('chat.delta', { text: 'hel' }) }],
  'chat.done': [{ form: 'event', msg: evt('chat.done', { full: 'hello' }) }],
  'chat.error': [{ form: 'event', msg: evt('chat.error', { error: 'upstream failed' }) }],
  'chat.abort': [{ form: 'event', msg: evt('chat.abort') }],
  'settings.get': [
    { form: 'request', msg: req(5, 'settings.get') },
    { form: 'reply', replyFor: 'settings.get', msg: rep(5, { patch: { roamEnabled: true } }) },
  ],
  'settings.set': [
    { form: 'request', msg: req(6, 'settings.set', { patch: { roamEnabled: false } }) },
    { form: 'reply', replyFor: 'settings.set', msg: rep(6, { patch: { roamEnabled: false } }) },
  ],
  'settings.changed': [{ form: 'event', msg: evt('settings.changed', { patch: { roamEnabled: false } }) }],
  'mcp.servers.get': [
    { form: 'request', msg: req(7, 'mcp.servers.get') },
    {
      form: 'reply',
      replyFor: 'mcp.servers.get',
      msg: rep(7, { servers: [{ name: 'obsidian', transport: 'stdio', state: 'ready', toolCount: 3 }] }),
    },
  ],
  'mcp.status': [
    { form: 'event', msg: evt('mcp.status', { servers: [{ name: 'joplin', transport: 'streamable-http', state: 'ready', toolCount: 5 }] }) },
  ],
  'mcp.server.status': [
    { form: 'event', msg: evt('mcp.server.status', { enabled: true, port: 47822, clients: 1, tools: TOOL_NAMES }) },
  ],
};

const invalidCases = [
  { name: 'missing v', msg: { id: 1, t: 'roam.get' }, code: 'bad-envelope' },
  { name: 'wrong protocol version', msg: { v: 2, id: 1, t: 'roam.get' }, code: 'bad-envelope' },
  { name: 'reply missing ok', msg: { v: 1, id: 7, enabled: true }, code: 'bad-envelope' },
  { name: 'ok without id', msg: { v: 1, t: 'roam.get', ok: true }, code: 'bad-envelope' },
  { name: 'unknown type with id', msg: { v: 1, id: 7, t: 'nope' }, code: 'unknown-type' },
  { name: 'failed reply without error', msg: rep(7, { t: 'roam.get', ok: false }), code: 'bad-error' },
  { name: 'failed reply with partial error', msg: rep(7, { t: 'roam.get', ok: false, error: { code: 'x' } }), code: 'missing-field' },
  { name: 'reply payload missing declared field', msg: rep(8), replyFor: 'roam.get', code: 'missing-field' },
  { name: 'ok not boolean', msg: { v: 1, id: 7, t: 'roam.get', ok: 'yes' }, code: 'bad-envelope' },
  { name: 'request missing required field', msg: { v: 1, id: 1, t: 'hello', role: 'body', name: 'b', version: '0', protocol: 1 }, code: 'missing-field' },
  { name: 'request bad enum', msg: req(1, 'mode.request', { mode: 'dance' }), code: 'bad-field' },
  { name: 'bad id type', msg: { v: 1, id: '7', t: 'roam.get' }, code: 'bad-field' },
  { name: 'event used as request', msg: req(1, 'ping', { ts: 1 }), code: 'bad-form' },
];

const ROLE_EDGE = /^(body|brain|ui)>(body|brain|ui)$/;

function parseLegacySection(markdown) {
  const start = markdown.indexOf('## 5.');
  const end = markdown.indexOf('## 6.');
  if (start < 0 || end <= start) throw new Error('docs section 5 not found');
  const section = markdown.slice(start, end);
  const knownTypes = Object.keys(schema.messages);
  const legacy = {};

  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (cells[0].includes('舊（Electron IPC）') || /^-+$/.test(cells[0])) continue;

    const names = cells[0].split(/\s+\/\s+/);
    const targets = knownTypes
      .filter((type) => cells[1].includes(type))
      .sort((a, b) => cells[1].indexOf(a) - cells[1].indexOf(b));
    for (const name of names) legacy[name] = targets;
  }
  return legacy;
}

let testNo = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, fn) {
  testNo += 1;
  try {
    const detail = fn();
    console.log(`ok ${testNo} - ${name}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok ${testNo} - ${name}`);
    console.log(`  ${error.message}`);
  }
}

check('schema declares protocol 1', () => {
  assert(schema.format === 'aurapet-bridge-contract/1', `unexpected format ${schema.format}`);
  assert(schema.protocol === 1, 'protocol must be 1');
  return `${Object.keys(schema.messages).length} message types`;
});

check('message directions use body/brain/ui roles', () => {
  for (const [type, def] of Object.entries(schema.messages)) {
    assert(Array.isArray(def.dir) && def.dir.length > 0, `${type} has no dir`);
    for (const edge of def.dir) assert(ROLE_EDGE.test(edge), `${type} has bad dir ${edge}`);
  }
});

check('every message type has fixtures for each declared form', () => {
  const missing = [];
  for (const [type, def] of Object.entries(schema.messages)) {
    const list = fixtures[type] ?? [];
    for (const form of def.forms) {
      const covered = list.some((fixture) => fixture.form === form && (form !== 'reply' || fixture.replyFor === type));
      if (!covered) missing.push(`${type}:${form}`);
    }
  }
  assert(missing.length === 0, `missing fixtures: ${missing.join(', ')}`);
});

check('every declared reply contract has a fixture', () => {
  const missing = Object.entries(schema.messages)
    .filter(([type, def]) => def.reply && !(fixtures[type] ?? []).some((fixture) => fixture.form === 'reply' && fixture.replyFor === type))
    .map(([type]) => type);
  assert(missing.length === 0, `missing reply fixtures: ${missing.join(', ')}`);
});

check('fixtures only cover declared message types', () => {
  for (const type of Object.keys(fixtures)) {
    assert(schema.messages[type], `fixture for undeclared type ${type}`);
  }
});

check('all valid fixtures pass', () => {
  let count = 0;
  for (const [type, list] of Object.entries(fixtures)) {
    for (const fixture of list) {
      const result = validateMessage(fixture.msg, { replyFor: fixture.replyFor });
      assert(result.ok, `${type} ${fixture.form} rejected: ${result.error?.code} ${result.error?.message}`);
      assert(result.form === fixture.form, `${type} classified as ${result.form}, expected ${fixture.form}`);
      count += 1;
    }
  }
  return `${count} fixtures`;
});

check('invalid messages are rejected with expected code', () => {
  for (const testCase of invalidCases) {
    const result = validateMessage(testCase.msg, { replyFor: testCase.replyFor });
    assert(!result.ok, `${testCase.name} was accepted`);
    assert(result.error.code === testCase.code, `${testCase.name}: got ${result.error.code}, expected ${testCase.code}`);
  }
  return `${invalidCases.length} cases`;
});

check('unknown fields are ignored (additive rule)', () => {
  const result = validateMessage(evt('say', { text: 'hi', futureField: { nested: true } }));
  assert(result.ok, 'say with unknown field was rejected');
});

check('unknown event type without id is ignored', () => {
  const result = validateMessage(evt('future.event', { foo: 1 }));
  assert(result.ok && result.ignored, 'unknown event was not ignored');
});

check('unknown reply payload without correlation is accepted structurally', () => {
  const result = validateMessage(rep(9, { echoed: true }));
  assert(result.ok && result.form === 'reply', 't-less reply was rejected');
});

check('docs section 5 matches schema legacy channels', () => {
  const legacy = parseLegacySection(doc);
  const docNames = Object.keys(legacy).sort();
  const schemaNames = Object.keys(schema.legacyChannels).sort();
  assert(docNames.length === 14, `docs lists ${docNames.length} legacy channels, expected 14`);
  assert(JSON.stringify(docNames) === JSON.stringify(schemaNames), 'legacy channel names differ');
  for (const name of docNames) {
    assert(
      JSON.stringify(legacy[name]) === JSON.stringify(schema.legacyChannels[name]),
      `${name}: docs ${JSON.stringify(legacy[name])} != schema ${JSON.stringify(schema.legacyChannels[name])}`,
    );
  }
  return '14 channels';
});

check('legacy channel targets exist and are handled by the preload shim', () => {
  for (const [legacyName, targets] of Object.entries(schema.legacyChannels)) {
    assert(targets.length > 0, `${legacyName} has no target`);
    for (const target of targets) {
      assert(schema.messages[target], `${legacyName} -> undeclared ${target}`);
      // Since the WS migration the shim speaks protocol types, not IPC channel
      // names, so every mapped target must appear in preload.js.
      assert(preload.includes(`'${target}'`), `${target} (from ${legacyName}) not handled in preload.js`);
    }
  }
});

check('preload keeps the renderer electronAPI surface', () => {
  const required = [
    'switchMode',
    'setAlwaysOnTop',
    'minimizeApp',
    'closeApp',
    'setIgnoreMouseEvents',
    'setUiBusy',
    'notifyPetActivity',
    'getRoamEnabled',
    'setRoamEnabled'
  ];
  for (const name of required) assert(preload.includes(name), `${name} missing from preload.js`);
});

check('mcp server face declares the implemented tools (issue #14)', () => {
  const expected = ['pet.say', 'pet.mood.get', 'pet.ask', 'pet.ask.result', 'notes.search'];
  assert(JSON.stringify(TOOL_NAMES) === JSON.stringify(expected), `daemon/mcp-server.js exposes ${TOOL_NAMES.join(', ')}`);
  const fixture = fixtures['mcp.server.status'][0].msg;
  assert(JSON.stringify(fixture.tools) === JSON.stringify(expected), 'mcp.server.status fixture tools differ from daemon');
  assert(doc.includes('mcp.server.status'), 'docs section 4 is missing mcp.server.status');
  return `${expected.length} tools`;
});

check('docs status is CANDIDATE and points to machine-readable contract', () => {
  assert(doc.includes('Status：**CANDIDATE**'), 'docs status is not CANDIDATE');
  const start = doc.indexOf('## 6. 機器可讀契約');
  assert(start >= 0, 'docs section 6 (machine-readable contract) missing');
  const section = doc.slice(start, doc.indexOf('## 7.'));
  assert(section.includes('tools/bridge/protocol.schema.json'), 'schema path missing from docs');
  assert(section.includes('tools/bridge/contract-test.mjs'), 'contract test path missing from docs');
});

if (failures.length > 0) {
  console.log(`\n${failures.length} of ${testNo} checks failed`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${testNo} contract checks passed`);
}
