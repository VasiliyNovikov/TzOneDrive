import { createBrowserAdapter } from './browser.js';

export function createTizenAdapter(target = window) {
  const adapter = createBrowserAdapter(target);
  adapter.name = 'Samsung Tizen / TV remote';
  for (const key of ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'Info',
    ...Array.from({ length: 10 }, (_, digit) => String(digit))]) {
    try {
      target.tizen.tvinputdevice.registerKey(key);
    } catch (error) {
      adapter.warnings.push(`${key}: ${error.name || 'unavailable'}`);
    }
  }
  return adapter;
}
