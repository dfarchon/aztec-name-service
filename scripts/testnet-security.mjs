/** Allow frames only from the wallet URLs passed to the same site build. */
export function contentSecurityPolicy(walletUrls = '') {
  const origins = new Set();
  for (const value of walletUrls
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error(`Invalid web wallet URL: ${value}`);
    origins.add(url.origin);
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    // bb.js ships its WASM as an inlined `data:application/gzip` URL and loads it with fetch(). Without
    // `data:` the first function-selector hash fails with "Failed to fetch", so no transaction can be built.
    // A data: URL is read locally and cannot carry anything off the page.
    "connect-src 'self' data: https: wss:",
    `frame-src 'self'${origins.size ? ` ${[...origins].join(' ')}` : ''}`,
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}
