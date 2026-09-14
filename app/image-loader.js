export class ImageLoader {
  constructor({
    createImage = () => new Image(),
    concurrency = 3,
    maxEntries = 16,
    timeoutMs = 12000,
  } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1
      || !Number.isInteger(maxEntries) || maxEntries < concurrency) {
      throw new Error('Image limits must be positive integers; cache must cover concurrency.');
    }
    this.createImage = createImage;
    this.concurrency = concurrency;
    this.maxEntries = maxEntries;
    this.timeoutMs = timeoutMs;
    this.entries = new Map();
    this.queue = [];
    this.active = 0;
    this.disposed = false;
  }

  stats() {
    return { active: this.active, queued: this.queue.length, cached: this.entries.size };
  }

  load(url, { priority = 0 } = {}) {
    if (this.disposed) return Promise.reject(new Error('Image loader is closed.'));
    const existing = this.entries.get(url);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      this.entries.delete(url);
      this.entries.set(url, existing);
      this.queue.sort((a, b) => a.priority - b.priority);
      return existing.promise;
    }
    if (this.entries.size >= this.maxEntries) {
      const evictable = [...this.entries.values()].find((entry) => entry.status === 'loaded')
        || [...this.queue].reverse().find((entry) => entry.priority > priority);
      if (!evictable) return Promise.reject(new Error('Image queue is full.'));
      this.remove(evictable);
    }
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    const entry = { url, priority, promise, resolve, reject, status: 'queued', image: null };
    this.entries.set(url, entry);
    this.queue.push(entry);
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
    return promise;
  }

  remove(entry) {
    this.entries.delete(entry.url);
    this.queue = this.queue.filter((item) => item !== entry);
    if (entry.status === 'queued') entry.reject(new Error('Image request was superseded.'));
    entry.image = null;
  }

  retain(urls) {
    const wanted = new Set(urls);
    for (const entry of [...this.queue]) {
      if (!wanted.has(entry.url)) this.remove(entry);
    }
  }

  pump() {
    while (!this.disposed && this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.shift();
      entry.status = 'loading';
      this.active += 1;
      let timer;
      const finish = (error) => {
        if (entry.status !== 'loading') return;
        clearTimeout(timer);
        if (entry.image) {
          entry.image.onload = null;
          entry.image.onerror = null;
        }
        this.active -= 1;
        if (error) {
          entry.status = 'failed';
          this.entries.delete(entry.url);
          entry.image = null;
          entry.reject(error);
        } else {
          entry.status = 'loaded';
          entry.resolve(entry.url);
        }
        this.pump();
      };
      entry.cancel = () => finish(new Error('Image loader is closed.'));
      try {
        entry.image = this.createImage();
        entry.image.onload = () => finish();
        entry.image.onerror = () => finish(new Error('This image could not be loaded.'));
        timer = setTimeout(() => finish(new Error('Image loading timed out.')), this.timeoutMs);
        entry.image.src = entry.url;
      } catch (error) {
        finish(error);
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      if (entry.status === 'loading') entry.cancel();
      else this.remove(entry);
    }
  }
}
