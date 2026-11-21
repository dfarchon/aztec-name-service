/**
 * Uncommitted changes that block a versioned release or mark a build `-dirty`, from `git status --porcelain` output.
 *
 * `package-lock.json` is deliberately ignored, so an `npm install` that rewrites it on the build machine does not block
 * the release. The release ID then names the commit but no longer guarantees the committed dependency set; `npm ci`
 * installs exactly the committed lockfile and remains the recommended install.
 */
export function sourceChanges(porcelain) {
  return String(porcelain ?? '')
    .split('\n')
    .filter((line) => line.trim() && line.replace(/^\s*\S{1,2}\s+/, '') !== 'package-lock.json')
    .join('\n');
}
