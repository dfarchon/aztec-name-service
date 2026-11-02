import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { RouteBoundary } from '../src/RouteBoundary.tsx';

// Exercise the lifecycle reset directly; rendering the fallback needs a browser/renderer.
test('a failed route resets when the route argument changes', () => {
  const boundary = new RouteBoundary({ children: null, resetKey: 'name:b' });
  boundary.state = { failed: true };
  const update = mock.method(boundary, 'setState', () => {});
  boundary.componentDidUpdate({ children: null, resetKey: 'name:a' });
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0].arguments, [{ failed: false }]);
});

test('a failed route stays failed when its reset key is unchanged', () => {
  const boundary = new RouteBoundary({ children: null, resetKey: 'name:a' });
  boundary.state = { failed: true };
  const update = mock.method(boundary, 'setState', () => {});
  boundary.componentDidUpdate({ children: null, resetKey: 'name:a' });
  assert.equal(update.mock.callCount(), 0);
});

test('a healthy route does not update state when its reset key changes', () => {
  const boundary = new RouteBoundary({ children: null, resetKey: 'name:b' });
  const update = mock.method(boundary, 'setState', () => {});
  boundary.componentDidUpdate({ children: null, resetKey: 'name:a' });
  assert.equal(update.mock.callCount(), 0);
});
