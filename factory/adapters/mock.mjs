import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ACTION_KEYS, VISUAL_CRITERIA } from '../acceptance.mjs';
import { AdapterError } from './process.mjs';

export const MOCK_SCENARIOS = Object.freeze([
  'pass', 'navigation-failure', 'missing-camera', 'obstructed', 'unreadable',
  'stale-frame', 'reused-frame', 'invalid-verdict', 'hash-mismatch',
  'build-mismatch', 'disconnected', 'timeout', 'inference-unavailable',
]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const name = Buffer.from(type);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([header, name, bytes, checksum]);
}

function fixturePng(snapshot) {
  const width = 160;
  const height = 90;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  const palette = [[43, 111, 145], [211, 124, 57], [65, 112, 72]][snapshot.index];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + x * 3 + 1;
      for (let c = 0; c < 3; c += 1) pixels[offset + c] = Math.max(0, palette[c] - Math.floor(y / 3));
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`synthetic-fixture\0${JSON.stringify(snapshot)}`)),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function decodeFixture(path) {
  const bytes = await readFile(path);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) break;
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'tEXt') {
      const text = bytes.toString('utf8', offset + 8, offset + 8 + length);
      if (text.startsWith('synthetic-fixture\0')) return JSON.parse(text.slice(18));
    }
    offset += 12 + length;
  }
  throw new AdapterError('INVALID_FRAME', 'Not a synthetic fixture image');
}

export function createMockAdapters(config) {
  const scenario = config.mock?.scenario ?? 'pass';
  if (!MOCK_SCENARIOS.includes(scenario)) throw new AdapterError('INVALID_CONFIG', 'Unknown mock scenario');
  const outputDir = resolve(config.camera?.outputDir ?? '.factory/mock-camera');
  const build = { ...config.expectedBuild };
  const state = { screen: 'diagnostics', index: 0, playing: false, challenge: '000000' };
  let previousBytes;
  const beforeMatches = {
    'browse-folders': (s) => s.screen === 'diagnostics',
    'open-folder': (s) => s.screen === 'folders',
    'open-photo': (s) => s.screen === 'folder',
    'next-photo': (s) => s.screen === 'photo' && s.index === 0 && !s.playing,
    'previous-photo': (s) => s.screen === 'photo' && s.index === 1 && !s.playing,
    'start-slideshow': (s) => s.screen === 'photo' && s.index === 0 && !s.playing,
    'pause-slideshow': (s) => s.screen === 'photo' && s.playing,
    'back-to-folder': (s) => s.screen === 'photo' && !s.playing,
    'back-to-folders': (s) => s.screen === 'folder',
  };
  const afterMatches = {
    'browse-folders': (a) => a.screen === 'folders',
    'open-folder': (a) => a.screen === 'folder',
    'open-photo': (a) => a.screen === 'photo' && a.index === 0 && !a.playing,
    'next-photo': (a) => a.screen === 'photo' && a.index === 1 && !a.playing,
    'previous-photo': (a) => a.screen === 'photo' && a.index === 0 && !a.playing,
    'start-slideshow': (a, b) => a.screen === 'photo' && a.playing && a.index !== b.index,
    'pause-slideshow': (a, b) => a.screen === 'photo' && !a.playing && a.index === b.index,
    'back-to-folder': (a) => a.screen === 'folder',
    'back-to-folders': (a) => a.screen === 'folders',
  };
  return {
    mode: 'mock',
    synthetic: true,
    diagnostics: async () => ({ sdkAvailable: true, sdbAvailable: true, cameraAvailable: scenario !== 'missing-camera', synthetic: true }),
    connect: async () => scenario !== 'disconnected',
    checkConnection: async () => scenario !== 'disconnected',
    preparePackage: async () => ({ name: 'TzOneDrive.wgt', sha256: createHash('sha256').update(JSON.stringify(build)).digest('hex'), synthetic: true }),
    install: async () => true,
    launch: async () => { state.screen = 'diagnostics'; state.index = 0; state.playing = false; return true; },
    visualReady: async () => scenario !== 'inference-unavailable',
    remote: async ({ key }) => {
      if (!ACTION_KEYS.includes(key)) throw new AdapterError('INVALID_ACTION', 'Remote key is not allowlisted');
      if (scenario === 'timeout') return new Promise(() => {});
      if (key.startsWith('DIGIT_')) {
        state.challenge = (state.challenge + key.slice(-1)).slice(-6);
      } else if (key === 'BACK') {
        state.screen = { diagnostics: 'folders', folders: 'diagnostics', folder: 'folders', photo: 'folder' }[state.screen];
        state.playing = false;
      } else if (key === 'ENTER') {
        state.screen = { folders: 'folder', folder: 'photo' }[state.screen] ?? state.screen;
      } else if (state.screen === 'photo' && key === 'RIGHT' && scenario !== 'navigation-failure') {
        state.index = (state.index + 1) % 3;
      } else if (state.screen === 'photo' && key === 'LEFT') {
        state.index = (state.index + 2) % 3;
      } else if (state.screen === 'photo' && key === 'PLAY_PAUSE') {
        state.playing = !state.playing;
        if (state.playing) state.index = (state.index + 1) % 3;
      }
      return true;
    },
    capture: async ({ requestId }) => {
      if (scenario === 'missing-camera') throw new AdapterError('CAMERA_UNAVAILABLE', 'Mock camera is unavailable');
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const path = join(outputDir, `synthetic-${requestId}-${randomUUID()}.png`);
      const snapshot = {
        ...state, build: scenario === 'build-mismatch' ? { ...build, commit: 'f'.repeat(40) } : build,
        readable: scenario !== 'unreadable', unobstructed: scenario !== 'obstructed', synthetic: true,
      };
      const bytes = scenario === 'reused-frame' && previousBytes ? previousBytes : fixturePng(snapshot);
      previousBytes = bytes;
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      return {
        path, capturedAt: new Date(Date.now() - (scenario === 'stale-frame' ? 60_000 : 0)).toISOString(),
        monotonicNs: process.hrtime.bigint().toString(),
        sha256: scenario === 'hash-mismatch' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
      };
    },
    detectBuild: async ({ requestId, framePath, frameSha256 }) => {
      const fixture = await decodeFixture(framePath);
      return {
        schemaVersion: 1, requestId, frameSha256,
        challenge: fixture.challenge, ...fixture.build,
        readable: fixture.readable, unobstructed: fixture.unobstructed,
      };
    },
    evaluate: async ({ step, before, after }) => {
      if (scenario === 'invalid-verdict') return { verdict: 'PASS', reason: 'Missing fixed criteria' };
      const b = await decodeFixture(before.path);
      const a = await decodeFixture(after.path);
      const criteria = Object.fromEntries(VISUAL_CRITERIA.map((key) => [key, true]));
      criteria.beforeState = beforeMatches[step.id](b);
      criteria.afterState = afterMatches[step.id](a, b);
      criteria.remoteResponse = criteria.afterState;
      return {
        verdict: Object.values(criteria).every(Boolean) ? 'PASS' : 'FAIL', criteria,
        reason: Object.values(criteria).every(Boolean) ? 'Synthetic before/after fixture assertions match' : 'Synthetic navigation differs from the fixed expected state',
      };
    },
  };
}
