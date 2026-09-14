import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initialState, reduce, focusContext } from '../app/state.js';
import { createFixtureProvider } from '../app/providers/fixtures.js';
import { directionalTarget, FocusController } from '../app/focus.js';
import { ImageLoader } from '../app/image-loader.js';
import { normalizeKey, createBrowserAdapter } from '../app/adapters/browser.js';
import { createTizenAdapter } from '../app/adapters/tizen.js';
import { getBuildIdentity, stampIndex } from '../scripts/build.mjs';
import { createAppServer, safePath } from '../scripts/serve.mjs';

async function photoState() {
  const provider = createFixtureProvider();
  const folders = await provider.listFolders();
  let state = reduce(initialState(), { type: 'FOLDERS_LOADED', folders });
  state = reduce(state, { type: 'OPEN_FOLDER', id: folders[0].id });
  state = reduce(state, {
    type: 'PHOTOS_LOADED', folderId: folders[0].id, photos: await provider.listPhotos(folders[0].id),
  });
  return reduce(state, { type: 'OPEN_PHOTO', index: 0 });
}

test('pure state starts with accessible diagnostics and rejects invalid navigation', () => {
  const state = Object.freeze(initialState());
  assert.equal(state.screen, 'diagnostics');
  assert.equal(reduce(state, { type: 'BACK' }).screen, 'folders');
  assert.equal(reduce(state, { type: 'NAVIGATE', screen: 'unknown' }), state);
  assert.equal(reduce(state, { type: 'OPEN_FOLDER', id: 'unknown' }), state);
  assert.equal(reduce(state, { type: 'OPEN_PHOTO', index: 0 }), state);
  assert.equal(reduce(state, { type: 'TOGGLE_SLIDESHOW' }), state);
  assert.equal(reduce(state, { type: 'UNKNOWN' }), state);
  assert.equal(state.lastKey, 'No input yet');
  assert.equal(reduce(state, { type: 'KEY', label: 'x'.repeat(500) }).lastKey.length, 100);
});

test('photo and slideshow transitions wrap, pause on Back, and restore the collection', async () => {
  const state = Object.freeze(await photoState());
  assert.equal(reduce(state, { type: 'OPEN_PHOTO', index: -1 }), state);
  assert.equal(reduce(state, { type: 'OPEN_PHOTO', index: 1.5 }), state);
  assert.equal(reduce(state, { type: 'STEP', delta: -1 }).photoIndex, state.photos.length - 1);
  assert.equal(reduce(state, { type: 'TICK' }), state);
  const playing = reduce(state, { type: 'TOGGLE_SLIDESHOW' });
  assert.equal(playing.playing, true);
  assert.equal(reduce(playing, { type: 'TICK' }).photoIndex, 1);
  const paused = reduce(playing, { type: 'BACK' });
  assert.equal(paused.screen, 'photo');
  assert.equal(paused.playing, false);
  const folder = reduce(paused, { type: 'BACK' });
  assert.equal(folder.screen, 'folder');
  assert.equal(focusContext(folder), `folder:${state.folderId}`);
  assert.equal(reduce(folder, { type: 'BACK' }).screen, 'folders');
  assert.equal(state.photoIndex, 0);
});

test('diagnostics and sign-in return to the originating screen without autoplay', async () => {
  const state = reduce(await photoState(), { type: 'TOGGLE_SLIDESHOW' });
  const diagnostics = reduce(state, { type: 'NAVIGATE', screen: 'diagnostics' });
  assert.equal(diagnostics.playing, false);
  const signIn = reduce(diagnostics, { type: 'NAVIGATE', screen: 'signin' });
  assert.equal(reduce(signIn, { type: 'BACK' }).screen, 'photo');
  assert.equal(reduce(signIn, { type: 'BACK' }).playing, false);
});

test('stale folder responses and errors cannot overwrite another collection', async () => {
  const state = await photoState();
  assert.equal(reduce(state, { type: 'PHOTOS_LOADED', folderId: 'old', photos: [] }), state);
  assert.equal(reduce(state, { type: 'LOAD_ERROR', folderId: 'old', message: 'failed' }), state);
  const failed = reduce(state, { type: 'LOAD_ERROR', folderId: state.folderId, message: 'Unavailable' });
  assert.equal(failed.error, 'Unavailable');
  assert.equal(failed.loading, false);
});

test('fixture provider is local, deterministic, read-only, and has no pretend authentication', async () => {
  const provider = createFixtureProvider();
  assert.deepEqual(await provider.getSession(), { mode: 'fixture', authenticated: false, capabilities: ['read'] });
  assert.equal((await provider.beginSignIn()).available, false);
  assert.deepEqual(await provider.listFolders('unsupported'), []);
  assert.deepEqual(await provider.listFolders(), await createFixtureProvider().listFolders());
  for (const folder of await provider.listFolders()) {
    const photos = await provider.listPhotos(folder.id);
    assert.equal(photos.length, folder.count);
    for (const photo of photos) {
      assert.match(provider.getPhotoSource(photo), /^\.\/assets\/photos\/[a-z-]+\.svg$/);
      assert.match(await readFile(new URL(`../app/${photo.full}`, import.meta.url), 'utf8'), /<svg/);
    }
  }
  await assert.rejects(provider.listPhotos('not-found'), /not available/);
});

const box = (id, x, y, width = 100, height = 100) => ({ id, left: x, top: y, width, height });
test('directional focus uses spatial rows, columns, and stable edge behavior', () => {
  const items = [
    box('a', 0, 0), box('b', 120, 0), box('c', 240, 0),
    box('d', 0, 120), box('e', 120, 120), box('f', 240, 120),
  ];
  assert.equal(directionalTarget(items[0], items, 'right'), 'b');
  assert.equal(directionalTarget(items[0], items, 'down'), 'd');
  assert.equal(directionalTarget(items[4], items, 'up'), 'b');
  assert.equal(directionalTarget(items[2], items, 'right'), null);
  assert.equal(directionalTarget(items[0], items, 'up'), null);
  assert.equal(directionalTarget(null, items, 'left'), null);
  assert.equal(directionalTarget(items[0], items, 'invalid'), null);
});

test('focus controller restores each screen and ignores disabled or missing targets', () => {
  const document = { activeElement: null };
  const element = (id, x = 0, disabled = false) => ({
    dataset: { focusId: id }, disabled,
    getClientRects: () => [box(id, x, 0)],
    getBoundingClientRect: () => box(id, x, 0),
    focus() { document.activeElement = this; },
    scrollIntoView() {},
  });
  let elements = [element('a'), element('b', 120), element('disabled', 240, true)];
  const root = { ownerDocument: document, querySelectorAll: () => elements };
  const controller = new FocusController(root);
  controller.restore('folder', 'a');
  controller.move('right');
  assert.equal(document.activeElement.dataset.focusId, 'b');
  assert.equal(controller.move('right'), false);
  controller.capture();
  elements = [element('stage')];
  controller.restore('photo', 'stage');
  elements = [element('a'), element('b', 120)];
  controller.restore('folder', 'a');
  assert.equal(document.activeElement.dataset.focusId, 'b');
  assert.equal(elements[0].tabIndex, -1);
  assert.equal(elements[1].tabIndex, 0);
  elements = [element('a')];
  controller.restore('folder', 'a');
  assert.equal(document.activeElement.dataset.focusId, 'a');
});

function fakeImages() {
  const images = [];
  return {
    images,
    createImage() {
      const image = { src: '', onload: null, onerror: null };
      images.push(image);
      return image;
    },
  };
}

test('image pipeline bounds concurrency and cache, deduplicates, and evicts old loaded entries', async () => {
  const fake = fakeImages();
  const loader = new ImageLoader({ createImage: fake.createImage, concurrency: 2, maxEntries: 3 });
  const a = loader.load('a');
  assert.equal(loader.load('a'), a);
  const b = loader.load('b');
  const c = loader.load('c');
  assert.deepEqual(loader.stats(), { active: 2, queued: 1, cached: 3 });
  await assert.rejects(loader.load('d'), /full/);
  fake.images[0].onload();
  assert.equal(fake.images[2].src, 'c');
  fake.images[1].onload();
  fake.images[2].onload();
  await Promise.all([a, b, c]);
  const d = loader.load('d');
  assert.equal(loader.stats().cached, 3);
  assert.equal(loader.entries.has('a'), false);
  fake.images[3].onload();
  assert.equal(await d, 'd');
  loader.dispose();
  assert.deepEqual(loader.stats(), { active: 0, queued: 0, cached: 0 });
});

test('foreground image requests displace queued preloads, while stale queued work is dropped', async () => {
  const fake = fakeImages();
  const loader = new ImageLoader({ createImage: fake.createImage, concurrency: 1, maxEntries: 3 });
  const a = loader.load('a');
  const b = loader.load('b', { priority: 1 });
  const c = loader.load('c', { priority: 1 });
  const cancelledC = assert.rejects(c, /superseded/);
  const d = loader.load('d');
  const cancelledB = assert.rejects(b, /superseded/);
  loader.retain(['a', 'd']);
  fake.images[0].onload();
  assert.equal(fake.images[1].src, 'd');
  fake.images[1].onload();
  await Promise.all([a, d, cancelledB, cancelledC]);
  loader.dispose();
});

test('image errors, timeouts, and disposal settle all promises and release capacity', async () => {
  const fake = fakeImages();
  const loader = new ImageLoader({ createImage: fake.createImage, concurrency: 1, maxEntries: 2, timeoutMs: 15 });
  const bad = loader.load('bad');
  const badResult = assert.rejects(bad, /could not be loaded/);
  fake.images[0].onerror();
  await badResult;
  await assert.rejects(loader.load('slow'), /timed out/);
  assert.equal(loader.stats().active, 0);
  const active = loader.load('active');
  const queued = loader.load('queued');
  const closed = Promise.all([assert.rejects(active, /closed/), assert.rejects(queued, /superseded/)]);
  loader.dispose();
  await closed;
  await assert.rejects(loader.load('after'), /closed/);
  assert.deepEqual(loader.stats(), { active: 0, queued: 0, cached: 0 });
  assert.throws(() => new ImageLoader({ concurrency: 0 }), /limits/);
});

test('browser and Tizen adapters normalize keys and safely handle missing optional registrations', () => {
  assert.equal(normalizeKey({ key: 'ArrowRight' }), 'right');
  assert.equal(normalizeKey({ key: 'Escape' }), 'back');
  assert.equal(normalizeKey({ key: 'Unidentified', keyCode: 10009 }), 'back');
  assert.equal(normalizeKey({ keyCode: 10252 }), 'playpause');
  assert.equal(normalizeKey({ key: 'i' }), 'diagnostics');
  assert.equal(normalizeKey({ key: 'F12' }), null);
  assert.equal(normalizeKey({ key: '0' }), 'digit-0');
  assert.equal(normalizeKey({ key: 'Unidentified', keyCode: 57 }), 'digit-9');
  assert.equal(normalizeKey({ keyCode: 96 }), 'digit-0');
  const events = {};
  const target = {
    addEventListener: (name, handler) => { events[name] = handler; },
    removeEventListener: (name) => { delete events[name]; },
    tizen: { tvinputdevice: { registerKey: () => { throw new Error('Not supported'); } } },
  };
  const adapter = createBrowserAdapter(target);
  const received = [];
  const unsubscribe = adapter.subscribe((key) => received.push(key));
  let prevented = false;
  events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  events.keydown({ key: 'Enter', repeat: true, preventDefault() {} });
  events.keydown({ key: '0', repeat: true, preventDefault() {} });
  assert.equal(prevented, true);
  assert.equal(received.length, 1);
  unsubscribe();
  assert.equal(events.keydown, undefined);
  assert.equal(createTizenAdapter(target).warnings.length, 15);
});

test('camera challenge retains exactly six digits without changing navigation or playback', () => {
  let state = { ...initialState(), screen: 'photo', playing: true };
  for (const digit of '123456000007') state = reduce(state, { type: 'CHALLENGE_DIGIT', digit });
  assert.equal(state.cameraChallenge, '000007');
  assert.equal(state.screen, 'photo');
  assert.equal(state.playing, true);
  for (const digit of ['', '12', '<', null, 0]) {
    assert.equal(reduce(state, { type: 'CHALLENGE_DIGIT', digit }), state);
  }
});

test('build identity requires a full SHA and stamps an independent camera mark', async () => {
  const identity = await getBuildIdentity({ env: { BUILD_ID: 'A'.repeat(40) } });
  assert.equal(identity.commit, 'a'.repeat(40));
  assert.equal(identity.buildId, identity.commit);
  await assert.rejects(getBuildIdentity({ env: { BUILD_ID: 'short' } }), /full 40-character/);
  const source = '<aside data-build-commit="UNSTAMPED">SOURCE · UNSTAMPED</aside>';
  const stamped = stampIndex(source, identity);
  assert.match(stamped, new RegExp(`data-build-commit="${identity.commit}"`));
  assert.ok(stamped.includes(`v${identity.version} · ${identity.commit}`));
});

test('server path parsing rejects traversal, encoded separators, dotfiles, and malformed requests', () => {
  assert.equal(safePath('/'), 'index.html');
  assert.equal(safePath('/assets/photos/coast.svg?x=1'), 'assets/photos/coast.svg');
  for (const url of ['/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json',
    '/.git/config', '/%00', '/%zz', '/assets\\..\\package.json', '/assets/%2e/secret']) {
    assert.equal(safePath(url), null, url);
  }
});

test('static server rejects the root itself and symlinks outside its exact asset directory', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tzonedrive-server-'));
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'app');
  const outside = path.join(directory, 'app-other');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, 'build.json'), JSON.stringify({
    commit: 'a'.repeat(40), buildId: 'a'.repeat(40), version: '1.0.0', mode: 'development',
  }));
  await writeFile(path.join(outside, 'fixture.json'), '{"outside":true}');
  await symlink(path.join(outside, 'fixture.json'), path.join(root, 'linked.json'));
  await symlink(outside, path.join(root, 'linked-directory'));
  server = await createAppServer({ appRoot: root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  for (const url of ['/linked.json', '/linked-directory/fixture.json', `/${root}`]) {
    const result = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: server.address().port, path: url }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
    });
    assert.equal(result.status, 403, url);
    assert.equal(result.body, 'Forbidden');
  }
});

test('static server serves only app assets with CSP and stamped identity', async (context) => {
  const server = await createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (url, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: url, method,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-security-policy'], /connect-src 'none'/);
  assert.match(index.body, /data-build-commit="[a-f0-9]{40}"/);
  assert.match((await request('/build.js')).body, /"commit": "[a-f0-9]{40}"/);
  assert.equal((await request('/%2e%2e/package.json')).status, 403);
  assert.equal((await request('/package.json')).status, 404);
  assert.equal((await request('/.git/config')).status, 403);
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal((await request('/', 'HEAD')).body, '');
});
