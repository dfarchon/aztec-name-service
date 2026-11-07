// Loaded only by the pinned contract-test launcher and inherited by its Node children.
// Outbound connections are untouched. Unsupported prebound handles fail closed.
const net = require('node:net');
const dgram = require('node:dgram');
const { syncBuiltinESMExports } = require('node:module');

function host(value, ipv6 = false) {
  if (value === undefined || value === '' || value === '0.0.0.0') return ipv6 ? '::1' : '127.0.0.1';
  if (value === '::') return '::1';
  if (value === '127.0.0.1' || value === '::1') return value;
  throw new Error('TXE listener policy rejects non-loopback host');
}
// Match Node's numeric-string/pipe distinction, including empty, whitespace and hex ports.
const port = value => typeof value === 'number' || (typeof value === 'string' && Number(value) >= 0);
const reject = () => { throw new Error('TXE listener policy rejects unsupported bind shape'); };
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  if (typeof first === 'string' && !port(first)) return listen.apply(this, args); // Unix socket.
  if (first && typeof first === 'object') {
    if ('fd' in first || 'handle' in first) reject();
    if (typeof first.path === 'string' && !('port' in first)) return listen.apply(this, args);
    if (!port(first.port)) reject();
    args[0] = { ...first, host: host(first.host) };
  } else if (port(first)) {
    if (typeof args[1] === 'string') args[1] = host(args[1]);
    else args.splice(1, 0, '127.0.0.1');
  } else reject();
  return listen.apply(this, args);
};
const bind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const first = args[0], ipv6 = this.type === 'udp6';
  if (first && typeof first === 'object') {
    if ('fd' in first || 'handle' in first || !port(first.port)) reject();
    args[0] = { ...first, address: host(first.address, ipv6) };
  } else if (port(first) || first === undefined || typeof first === 'function') {
    const callback = typeof first === 'function' ? first : undefined;
    if (!port(first)) args = [0, ...(callback ? [callback] : args.slice(1))];
    if (typeof args[1] === 'string') args[1] = host(args[1], ipv6);
    else args.splice(1, 0, host(undefined, ipv6));
  } else reject();
  return bind.apply(this, args);
};
syncBuiltinESMExports();
