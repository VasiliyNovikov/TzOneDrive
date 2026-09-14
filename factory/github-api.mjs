import { inflateRawSync } from 'node:zlib';

export const REPOSITORY = 'VasiliyNovikov/TzOneDrive';

export class GitHubError extends Error {
  constructor(status, message) {
    super(`GitHub ${status}: ${message}`);
    this.status = status;
  }
}

export class GitHubAPI {
  constructor({ token, repository = REPOSITORY, fetchImpl = fetch } = {}) {
    if (!token) throw new Error('A repository-scoped GitHub App token is required');
    if (repository !== REPOSITORY) throw new Error('The factory is restricted to its installed repository');
    this.token = token;
    this.fetch = fetchImpl;
    this.root = `https://api.github.com/repos/${repository}`;
  }

  async request(method, path, body) {
    if ((path !== '' && !path.startsWith('/')) || path.startsWith('//') || /[\\#\r\n]/.test(path) ||
        path.split(/[/?]/).some(part => part === '..' || /%2e|%2f|%5c/i.test(part))) {
      throw new Error('Invalid repository API path');
    }
    const response = await this.fetch(`${this.root}${path}`, {
      method, redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: ['Bearer', this.token].join(' '),
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new GitHubError(response.status, error.message || 'Request failed');
    }
    return response.status === 204 ? null : response.json();
  }

  async list(path, limit = 10) {
    const items = [];
    for (let page = 1; page <= limit; page++) {
      const result = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = Array.isArray(result) ? result : result.workflow_runs || result.artifacts;
      if (!Array.isArray(batch)) throw new Error('Unexpected paginated GitHub response');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error('GitHub pagination bound exceeded; refusing incomplete identity lookup');
  }

  async downloadResult(artifactId) {
    if (!Number.isSafeInteger(artifactId) || artifactId < 1) throw new Error('Invalid artifact ID');
    const response = await this.fetch(`${this.root}/actions/artifacts/${artifactId}/zip`, {
      redirect: 'manual',
      headers: { Authorization: ['Bearer', this.token].join(' '), 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (response.status !== 302) throw new Error('Expected a signed GitHub artifact download');
    const location = new URL(response.headers.get('location'));
    if (location.protocol !== 'https:' || location.username || location.password || location.port ||
        !/^[a-z0-9-]+\.(?:blob\.core\.windows\.net|actions\.githubusercontent\.com)$/.test(location.hostname)) {
      throw new Error('Untrusted artifact download origin');
    }
    // Never forward the repository token to the signed storage URL.
    const archive = await this.fetch(location.href, { redirect: 'error' });
    if (!archive.ok) throw new Error('Artifact download failed');
    const bytes = await boundedBytes(archive, 1024 * 1024);
    return JSON.parse(extractResult(bytes));
  }
}

async function boundedBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('Artifact too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('Artifact too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function extractResult(zip) {
  const fail = () => { throw new Error('Invalid or oversized result artifact'); };
  if (zip.length < 22 || zip.length > 1024 * 1024) fail();
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0 ||
      zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1) fail();
  const central = zip.readUInt32LE(end + 16);
  if (central + 46 > end || zip.readUInt32LE(central) !== 0x02014b50) fail();
  const flags = zip.readUInt16LE(central + 8);
  const method = zip.readUInt16LE(central + 10);
  const compressed = zip.readUInt32LE(central + 20);
  const size = zip.readUInt32LE(central + 24);
  const nameSize = zip.readUInt16LE(central + 28);
  const offset = zip.readUInt32LE(central + 42);
  if (flags & 1 || ![0, 8].includes(method) || size > 256 * 1024 ||
      central + 46 + nameSize > end ||
      zip.subarray(central + 46, central + 46 + nameSize).toString() !== 'result.json' ||
      offset + 30 > central || zip.readUInt32LE(offset) !== 0x04034b50) fail();
  const localNameSize = zip.readUInt16LE(offset + 26);
  const start = offset + 30 + localNameSize + zip.readUInt16LE(offset + 28);
  if (zip.subarray(offset + 30, offset + 30 + localNameSize).toString() !== 'result.json' ||
      start + compressed > central) fail();
  const input = zip.subarray(start, start + compressed);
  const output = method === 0 ? input : inflateRawSync(input, { maxOutputLength: 256 * 1024 });
  if (output.length !== size) fail();
  return output.toString('utf8');
}

export class GitHubContentsLedger {
  constructor(api, { branch = 'factory-ledger', path = 'ledger.json' } = {}) {
    if (branch !== 'factory-ledger' || path !== 'ledger.json') throw new Error('Untrusted ledger location');
    this.api = api;
    this.branch = branch;
    this.path = path;
  }

  async read() {
    try {
      const file = await this.api.request('GET', `/contents/${this.path}?ref=${this.branch}`);
      if (file.encoding !== 'base64' || file.size > 1024 * 1024) throw new Error('Invalid ledger object');
      return { version: file.sha, state: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) };
    } catch (error) {
      if (error.status === 404) return { version: null, state: null };
      throw error;
    }
  }

  async compareAndSwap(version, state) {
    if (!version) {
      const repository = await this.api.request('GET', '');
      const base = await this.api.request('GET', `/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
      try {
        await this.api.request('POST', '/git/refs', { ref: `refs/heads/${this.branch}`, sha: base.object.sha });
      } catch (error) {
        if (error.status !== 422) throw error;
      }
    }
    const content = Buffer.from(JSON.stringify(state));
    if (content.length > 1024 * 1024) throw new Error('Ledger exceeds the bounded storage size');
    try {
      const result = await this.api.request('PUT', `/contents/${this.path}`, {
        message: 'Advance trusted factory ledger',
        branch: this.branch, content: content.toString('base64'),
        ...(version ? { sha: version } : {})
      });
      return result.content.sha;
    } catch (error) {
      if ([409, 422].includes(error.status)) return false;
      throw error;
    }
  }
}
