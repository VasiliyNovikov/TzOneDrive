import { BUILD } from './build.js';
import { initialState, reduce, focusContext, SLIDESHOW_INTERVAL_MS } from './state.js';
import { createFixtureProvider } from './providers/fixtures.js';
import { createRenderer } from './render.js';
import { FocusController } from './focus.js';
import { ImageLoader } from './image-loader.js';
import { createBrowserAdapter } from './adapters/browser.js';
import { createTizenAdapter } from './adapters/tizen.js';

const root = document.querySelector('#app');
const provider = createFixtureProvider();
const adapter = window.tizen ? createTizenAdapter(window) : createBrowserAdapter(window);
const focus = new FocusController(root);
const images = new ImageLoader();
const renderer = createRenderer(root, {
  provider, build: BUILD, platform: adapter.name, warnings: adapter.warnings,
  userAgent: navigator.userAgent,
});
let state = initialState();
let slideshowTimer = null;
let folderRequest = 0;

function updateDiagnostics() {
  renderer.updateDiagnostics(state, images.stats(), {
    width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio,
  });
}

function loadImages() {
  const targets = [...root.querySelectorAll('img[data-src]')];
  const preloads = [];
  if (state.screen === 'photo' && state.photos.length > 1) {
    for (const delta of [1, -1]) {
      const index = (state.photoIndex + delta + state.photos.length) % state.photos.length;
      preloads.push(provider.getPhotoSource(state.photos[index]));
    }
  }
  images.retain([...targets.map((target) => target.dataset.src), ...preloads]);
  for (const target of targets) {
    images.load(target.dataset.src).then((src) => {
      if (!target.isConnected) return;
      target.src = src;
      target.parentElement.classList.add('loaded');
    }).catch(() => {
      if (target.isConnected) target.parentElement.classList.add('failed');
    }).finally(updateDiagnostics);
  }
  for (const src of preloads) {
    images.load(src, { priority: 1 }).catch(() => {}).finally(updateDiagnostics);
  }
}

function defaultFocus() {
  const defaults = {
    diagnostics: 'browse',
    folders: state.folders[0] ? `folder-${state.folders[0].id}` : 'nav-folders',
    folder: state.photos[0] ? `photo-${state.photos[0].id}` : 'back-to-folders',
    photo: 'photo-stage',
    signin: 'signin-demo',
  };
  return defaults[state.screen];
}

function render({ resetFocus = false } = {}) {
  focus.capture();
  if (resetFocus) focus.memory.delete(focusContext(state));
  renderer.render(state);
  focus.restore(focusContext(state), defaultFocus());
  loadImages();
  updateDiagnostics();
}

function dispatch(action) {
  const next = reduce(state, action);
  if (next === state) return;
  state = next;
  if (action.type === 'KEY') {
    updateDiagnostics();
    return;
  }
  if (slideshowTimer !== null) {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }
  if (state.playing && !document.hidden) {
    slideshowTimer = setInterval(() => dispatch({ type: 'TICK' }), SLIDESHOW_INTERVAL_MS);
  }
  render({ resetFocus: action.type === 'PHOTOS_LOADED' && state.screen === 'folder' });
}

async function loadFolders() {
  try {
    dispatch({ type: 'FOLDERS_LOADED', folders: await provider.listFolders() });
  } catch (error) {
    dispatch({ type: 'LOAD_ERROR', message: error.message });
  }
}

async function loadPhotos(folderId) {
  const request = ++folderRequest;
  try {
    const photos = await provider.listPhotos(folderId);
    if (request === folderRequest) dispatch({ type: 'PHOTOS_LOADED', folderId, photos });
  } catch (error) {
    if (request === folderRequest) dispatch({ type: 'LOAD_ERROR', folderId, message: error.message });
  }
}

function activate(action, target) {
  if (['folders', 'diagnostics', 'signin'].includes(action)) {
    dispatch({ type: 'NAVIGATE', screen: action });
  } else if (action === 'open-folder') {
    dispatch({ type: 'OPEN_FOLDER', id: target.dataset.id });
    loadPhotos(state.folderId);
  } else if (action === 'open-photo') {
    dispatch({ type: 'OPEN_PHOTO', index: Number(target.dataset.index) });
  } else if (action === 'toggle-slideshow') {
    dispatch({ type: 'TOGGLE_SLIDESHOW' });
  } else if (action === 'previous' || action === 'next') {
    dispatch({ type: 'STEP', delta: action === 'next' ? 1 : -1 });
  } else if (action === 'back') {
    dispatch({ type: 'BACK' });
  } else if (action === 'retry') {
    if (state.screen === 'folder') loadPhotos(state.folderId);
    else loadFolders();
  }
}

root.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  focus.focus(target);
  activate(target.dataset.action, target);
});
root.addEventListener('focusin', () => focus.capture());

const unsubscribe = adapter.subscribe(({ command, label }) => {
  dispatch({ type: 'KEY', label });
  if (['left', 'right', 'up', 'down'].includes(command)) {
    if (state.screen === 'photo' && ['left', 'right'].includes(command)
      && document.activeElement.dataset.focusId === 'photo-stage') {
      dispatch({ type: 'STEP', delta: command === 'right' ? 1 : -1 });
    } else focus.move(command);
  } else if (command === 'select') {
    const target = document.activeElement;
    if (root.contains(target) && target.matches('[data-action]')) target.click();
  } else if (command === 'back' || command === 'stop') {
    dispatch({ type: command === 'stop' ? 'SET_PLAYING' : 'BACK', playing: false });
  } else if (command === 'diagnostics') {
    dispatch({ type: 'NAVIGATE', screen: 'diagnostics' });
  } else if (command === 'playpause') {
    dispatch({ type: 'TOGGLE_SLIDESHOW' });
  } else if (command === 'play' || command === 'pause') {
    dispatch({ type: 'SET_PLAYING', playing: command === 'play' });
  }
});

window.addEventListener('resize', updateDiagnostics);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.playing) dispatch({ type: 'SET_PLAYING', playing: false });
});
window.addEventListener('pagehide', () => {
  unsubscribe();
  clearInterval(slideshowTimer);
  images.dispose();
});

render();
loadFolders();
