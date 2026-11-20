import { realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';

/**
 * Physical temp directory for tests. On macOS `os.tmpdir()` is under /var, a symlink to /private/var,
 * and the state-directory guards under test refuse symlinked ancestors by design.
 */
export const tmpdir = () => realpathSync(osTmpdir());
