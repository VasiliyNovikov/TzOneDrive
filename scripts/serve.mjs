import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildModule, getBuildIdentity, stampIndex } from './build.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml; charset=utf-8',
};

export function safePath(rawUrl) {
  const encoded = rawUrl.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(encoded); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return null;
  return decoded === '/' ? 'index.html' : decoded.slice(1);
}

export async function createAppServer({ appRoot = path.join(projectRoot, 'app'), stampSource = true } = {}) {
  const root = await realpath(appRoot);
  const sourceBuild = JSON.parse(await readFile(path.join(root, 'build.json'), 'utf8'));
  const identity = sourceBuild.commit === 'UNSTAMPED' && stampSource
    ? await getBuildIdentity({ mode: 'development' }) : sourceBuild;
  return http.createServer(async (request, response) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    function send(status, content = '') {
      response.writeHead(status, headers);
      response.end(request.method === 'HEAD' ? undefined : content);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      headers.Allow = 'GET, HEAD';
      send(405, 'Method not allowed');
      return;
    }
    const relative = safePath(request.url || '/');
    if (!relative) { send(403, 'Forbidden'); return; }
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      send(403, 'Forbidden');
      return;
    }
    try {
      const actual = await realpath(resolved);
      if (!actual.startsWith(`${root}${path.sep}`) || !(await stat(actual)).isFile()) {
        send(403, 'Forbidden');
        return;
      }
      const extension = path.extname(actual);
      if (!types[extension]) { send(403, 'Forbidden'); return; }
      headers['Content-Type'] = types[extension];
      let content;
      if (relative === 'build.js' && sourceBuild.commit === 'UNSTAMPED') content = buildModule(identity);
      else if (relative === 'build.json' && sourceBuild.commit === 'UNSTAMPED') content = `${JSON.stringify(identity, null, 2)}\n`;
      else if (relative === 'index.html' && sourceBuild.commit === 'UNSTAMPED') {
        content = stampIndex(await readFile(actual, 'utf8'), identity);
      } else content = await readFile(actual);
      send(200, content);
    } catch (error) {
      send(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, 'Not found');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 4173);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    const appRoot = path.resolve(projectRoot, process.env.APP_ROOT || 'app');
    const allowed = [path.join(projectRoot, 'app'), path.join(projectRoot, 'dist', 'app')];
    if (!allowed.includes(appRoot)) throw new Error('APP_ROOT must be app or dist/app; repository browsing is not supported.');
    const server = await createAppServer({ appRoot });
    server.on('error', (error) => {
      console.error(`Server failed: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`Offline viewer: http://${host}:${port} (root: ${path.relative(projectRoot, appRoot)})`);
    });
  } catch (error) {
    console.error(`Server failed: ${error.message}`);
    process.exitCode = 1;
  }
}
