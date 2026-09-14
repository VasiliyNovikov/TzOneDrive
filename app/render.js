const html = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const button = (label, action, id, className = '', attributes = '') => (
  `<button type="button" data-action="${action}" data-focus-id="${html(id)}"
    tabindex="-1" class="button ${className}" ${attributes}>${label}</button>`
);
const image = (src, alt, className = '') => (
  `<div class="image-shell ${className}"><img data-src="${html(src)}" alt="${html(alt)}">
    <span class="image-fallback">Image unavailable</span></div>`
);

function navigation(screen) {
  return `<header class="topbar">
    <div class="brand"><img src="./assets/icon.svg" alt="" width="40" height="40">
      <span>OneDrive<span class="brand-divider"> / </span><span class="brand-subtitle">Photos</span></span></div>
    <nav aria-label="Main navigation">
      ${button('Collections', 'folders', 'nav-folders', screen === 'folders' || screen === 'folder' ? 'nav active' : 'nav')}
      ${button('Diagnostics', 'diagnostics', 'nav-diagnostics', screen === 'diagnostics' ? 'nav active' : 'nav')}
      ${button('<span class="account-dot" aria-hidden="true"></span> Connect account', 'signin', 'nav-signin', screen === 'signin' ? 'nav active' : 'nav')}
    </nav>
  </header>`;
}

function diagnostics(state, info) {
  return `<main class="diagnostics-page">
    <section class="diagnostic-intro">
      <p class="eyebrow"><span class="live-dot"></span> LOCAL PREVIEW · READY TO EXPLORE</p>
      <h1>Your memories.<br><span class="muted-heading">A bigger canvas.</span></h1>
      <p class="intro-copy">A quieter way to enjoy your photos.<br>Made for the sofa. Ready for your remote.</p>
      <div class="actions">
        ${button('Explore collections <span aria-hidden="true">↗</span>', 'folders', 'browse', 'primary')}
        ${button('About sign-in', 'signin', 'about-signin', 'secondary')}
      </div>
      <div class="preview-note"><span class="note-icon" aria-hidden="true">✧</span>
        <p><strong>A private, offline preview</strong><br>All scenes are bundled synthetic illustrations.<br>No account, personal photos, or network requests.</p></div>
    </section>
    <section class="diagnostic-panel" aria-labelledby="diagnostics-heading">
      <div class="panel-title"><h2 id="diagnostics-heading">Device diagnostics</h2><span class="pill">LIVE</span></div>
      <p class="panel-caption">Build identity and remote input, visible before you begin.</p>
      <dl class="diagnostic-list">
        <div><dt>Application</dt><dd>v${html(info.build.version)} <span class="subtle">/ ${html(info.build.mode)}</span></dd></div>
        <div class="commit-row"><dt>Full commit ID</dt><dd id="diagnostic-commit">${html(info.build.commit)}</dd></div>
        <div><dt>Build ID</dt><dd>${html(info.build.buildId)}</dd></div>
        <div><dt>Platform</dt><dd>${html(info.platform)}</dd></div>
        <div><dt>Viewport</dt><dd id="diagnostic-viewport"></dd></div>
        <div><dt>Last key</dt><dd id="diagnostic-key" class="key-value" aria-live="polite">${html(state.lastKey)}</dd></div>
        <div><dt>Image pipeline</dt><dd id="diagnostic-images"></dd></div>
        <div class="runtime-row"><dt>Runtime user agent</dt><dd>${html(info.userAgent)}</dd></div>
      </dl>
      <p class="baseline">Provisional target: Chromium 94+. Device compatibility requires a real-TV check.</p>
      ${info.warnings.length ? `<p class="warning">${html(info.warnings.join(' · '))}</p>` : ''}
    </section>
  </main>`;
}

function collectionGrid(state) {
  return `<main class="library-page">
    <div class="page-heading"><div><p class="eyebrow">YOUR OFFLINE GALLERY</p><h1>Good places. Great moments.</h1>
      <p class="intro-copy">Pick a collection. Let the outside in.</p></div>
      <span class="collection-count">${state.folders.length} collections <span class="subtle">/ synthetic scenes</span></span>
    </div>
    ${loadStatus(state)}
    <div class="card-grid folder-grid" aria-label="Photo collections">
      ${state.folders.map((folder, index) => `<button type="button" class="collection-card" data-action="open-folder"
        data-id="${html(folder.id)}" data-focus-id="folder-${html(folder.id)}" tabindex="-1">
        ${image(folder.cover, folder.title)}
        <span class="card-shade"></span><span class="card-number">0${index + 1}</span>
        <span class="collection-card-copy"><span class="card-meta">${folder.count} SCENES</span>
          <strong>${html(folder.title)}</strong><span class="card-subtitle">${html(folder.subtitle)}</span></span>
        <span class="card-arrow" aria-hidden="true">↗</span>
      </button>`).join('')}
    </div>
    <div class="library-note"><span class="live-dot"></span> Demo library · Nothing leaves this device
      <span>OneDrive connection coming later</span></div>
  </main>`;
}

function loadStatus(state) {
  if (state.loading) return '<p class="status-message" role="status">Opening your collection…</p>';
  if (state.error) return `<div class="status-message warning" role="alert">${html(state.error)}
    ${button('Try again', 'retry', 'retry', 'secondary')}</div>`;
  return '';
}

function photos(state, provider) {
  const folder = state.folders.find((entry) => entry.id === state.folderId);
  return `<main class="library-page photos-page">
    <div class="page-heading"><div><p class="eyebrow">COLLECTION / ${html(folder ? folder.subtitle : 'Offline scenes')}</p>
      <h1>${html(folder ? folder.title : 'Photos')}</h1></div>
      <div class="actions">${button('← Collections', 'back', 'back-to-folders', 'secondary')}
        <span class="collection-count">${state.photos.length} scenes</span></div></div>
    ${loadStatus(state)}
    ${!state.loading && !state.error && !state.photos.length ? '<p class="status-message">This collection is empty.</p>' : ''}
    <div class="card-grid photo-grid" aria-label="Photos">
      ${state.photos.map((item, index) => `<button type="button" class="photo-card"
        data-action="open-photo" data-index="${index}" data-focus-id="photo-${html(item.id)}" tabindex="-1">
        ${image(provider.getPhotoSource(item, { variant: 'thumbnail' }), item.description)}
        <span class="photo-card-copy"><strong>${html(item.title)}</strong><span>${html(item.palette)}</span></span>
      </button>`).join('')}
    </div>
  </main>`;
}

function photoViewer(state, provider) {
  const item = state.photos[state.photoIndex];
  if (!item) return '<main><p class="status-message">No photo selected.</p></main>';
  return `<main class="viewer-page">
    <button type="button" class="photo-stage ${state.playing ? 'playing' : ''}" data-action="toggle-slideshow"
      data-focus-id="photo-stage" tabindex="-1" aria-label="${state.playing ? 'Pause' : 'Start'} slideshow">
      ${image(provider.getPhotoSource(item), item.description, 'full-photo')}
      <span class="stage-tip">${state.playing ? 'PLAYING · 5 SECOND INTERVAL' : '◀  PREVIOUS     ·     NEXT  ▶'}</span>
    </button>
    <div class="viewer-toolbar">
      <div class="viewer-caption"><p class="eyebrow">${String(state.photoIndex + 1).padStart(2, '0')} / ${String(state.photos.length).padStart(2, '0')}
        <span class="caption-separator">—</span> ${html(item.palette)}</p><h1>${html(item.title)}</h1></div>
      <div class="actions">
        ${button('←', 'previous', 'previous-photo', 'icon-button', 'aria-label="Previous photo"')}
        ${button(state.playing ? 'Ⅱ Pause' : '▷ Slideshow', 'toggle-slideshow', 'slideshow', 'primary')}
        ${button('→', 'next', 'next-photo', 'icon-button', 'aria-label="Next photo"')}
        ${button('Back to collection', 'back', 'back-to-photos', 'secondary')}
      </div>
    </div>
    <span id="slideshow-status" class="sr-only" role="status">${state.playing ? 'Slideshow playing' : 'Slideshow paused'}</span>
  </main>`;
}

function signIn() {
  return `<main class="signin-page">
    <section class="signin-card">
      <div class="signin-emblem"><img src="./assets/icon.svg" alt="" width="76" height="76"></div>
      <p class="eyebrow">YOUR ONEDRIVE, EVENTUALLY</p><h1>A place for your<br>own memories.</h1>
      <p class="intro-copy">Microsoft sign-in is not available in this preview.<br>There is no device code, login form, or account connection.</p>
      <div class="signin-boundary"><span aria-hidden="true">◇</span>
        <p><strong>Read-only. Personal. Yours.</strong><br>A future provider will use delegated access to personal OneDrive.<br>This build only opens the bundled synthetic library.</p></div>
      <div class="actions">${button('Explore the demo', 'folders', 'signin-demo', 'primary')}
        ${button('Go back', 'back', 'signin-back', 'secondary')}</div>
    </section>
    <div class="signin-art" aria-hidden="true"><img src="./assets/photos/coast.svg" alt=""><span>Make room for<br>the bigger picture.</span></div>
  </main>`;
}

export function createRenderer(root, { provider, build, platform, warnings, userAgent }) {
  const info = { provider, build, platform, warnings, userAgent };
  return {
    render(state) {
      const screens = {
        diagnostics: () => diagnostics(state, info),
        folders: () => collectionGrid(state),
        folder: () => photos(state, provider),
        photo: () => photoViewer(state, provider),
        signin: signIn,
      };
      root.innerHTML = navigation(state.screen) + screens[state.screen]() + `<footer class="remote-hints">
        <span><kbd>↑↓←→</kbd> Navigate</span><span><kbd>OK</kbd> ${state.screen === 'photo' ? 'Play / pause' : 'Select'}</span>
        <span><kbd>↩</kbd> ${state.playing ? 'Pause, then back' : 'Back'}</span><span><kbd>i</kbd> Diagnostics</span>
      </footer>`;
    },
    updateDiagnostics(state, stats, viewport) {
      const values = {
        'diagnostic-key': state.lastKey,
        'diagnostic-viewport': `${viewport.width} × ${viewport.height} · ${viewport.dpr}× DPR`,
        'diagnostic-images': `${stats.active}/3 active · ${stats.queued} queued · ${stats.cached}/16 cached`,
      };
      for (const [id, text] of Object.entries(values)) {
        const element = root.querySelector(`#${id}`);
        if (element) element.textContent = text;
      }
    },
  };
}
