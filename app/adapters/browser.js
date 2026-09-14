export function normalizeKey(event) {
  const names = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Enter: 'select', Escape: 'back', Backspace: 'back', BrowserBack: 'back',
    MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause',
    MediaStop: 'stop', ' ': 'playpause', i: 'diagnostics', I: 'diagnostics',
    d: 'diagnostics', D: 'diagnostics',
  };
  const codes = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'select',
    10009: 'back', 10252: 'playpause', 415: 'play', 19: 'pause',
    413: 'stop', 457: 'diagnostics',
  };
  return names[event.key] || codes[event.keyCode] || null;
}

export function createBrowserAdapter(target = window) {
  return {
    name: 'Browser / keyboard',
    warnings: [],
    subscribe(onInput) {
      const handler = (event) => {
        const command = normalizeKey(event);
        const label = `${event.key || 'Unnamed'} · ${event.keyCode || event.code || '—'}`;
        if (command) event.preventDefault();
        if (event.repeat && ['select', 'back', 'playpause', 'diagnostics'].includes(command)) return;
        onInput({ command, label });
      };
      target.addEventListener('keydown', handler);
      return () => target.removeEventListener('keydown', handler);
    },
  };
}
