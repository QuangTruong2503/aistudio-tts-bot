/**
 * Simple FIFO async Mutex and KeyedMutex for serializing critical sections
 * (e.g. CMS Publish Queue so 2 workers never upload concurrently on the same CMS page,
 * and brief UI focus locks when 2 workers share 1 Chrome window).
 */
class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  acquire() {
    return new Promise((resolve) => {
      const release = () => {
        const next = this._queue.shift();
        if (next) {
          next();
        } else {
          this._locked = false;
        }
      };

      if (!this._locked) {
        this._locked = true;
        resolve(release);
      } else {
        this._queue.push(() => resolve(release));
      }
    });
  }

  async runExclusive(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get isLocked() {
    return this._locked;
  }
}

class KeyedMutex {
  constructor() {
    this._locks = new Map();
  }

  _get(key) {
    const norm = String(key || 'default');
    let m = this._locks.get(norm);
    if (!m) {
      m = new Mutex();
      this._locks.set(norm, m);
    }
    return m;
  }

  async runExclusive(key, fn) {
    return this._get(key).runExclusive(fn);
  }

  isLocked(key) {
    const norm = String(key || 'default');
    const m = this._locks.get(norm);
    return m ? m.isLocked : false;
  }
}

module.exports = {
  Mutex,
  KeyedMutex,
};
