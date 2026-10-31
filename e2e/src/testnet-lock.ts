import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Prevent two runners from sharing wallet state or broadcasting the same test step. */
export function acquireTestnetLock(path: string): () => void {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
      finally { closeSync(fd); }
      return () => {
        try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A killed runner leaves its lock behind. Never remove a lock owned by a live process.
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid testnet lock; inspect it before retrying');
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; }
        throw error;
      }
      throw new Error(`Testnet runner ${owner.pid} already owns this state directory`);
    }
  }
  throw new Error('Unable to acquire testnet lock');
}
