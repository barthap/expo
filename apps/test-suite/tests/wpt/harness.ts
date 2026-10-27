// A small subset of WPT's `resources/testharness.js`, enough to run the vendored FileAPI
// files on the test-suite's jasmine. Assert semantics and messages follow upstream:
// https://github.com/web-platform-tests/wpt/blob/master/resources/testharness.js

import type { JasmineInterface } from '../../types';

/** One vendored WPT file, as listed in `vendor/index.js`. */
export type WptFile = {
  path: string;
  /** `// META: script=` support files, run before the test file. */
  scripts: (() => void)[];
  run: () => void;
};

class AssertionError extends Error {
  name = 'AssertionError';
}

const escapes: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\0': '\\0' };
for (let i = 1; i < 32; i++) {
  const named: Record<number, string> = { 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' };
  escapes[String.fromCharCode(i)] = '\\' + (named[i] ?? 'x' + i.toString(16).padStart(2, '0'));
}
for (const code of [0xfffd, 0xfffe, 0xffff]) {
  escapes[String.fromCharCode(code)] = '\\u' + code.toString(16);
}
const escapePattern = new RegExp('[\\\\"\\x00-\\x1f\\ufffd\\ufffe\\uffff]', 'g');

function format_value(val: any, seen: any[] = []): string {
  if (typeof val === 'object' && val !== null) {
    if (seen.includes(val)) return '[...]';
    seen.push(val);
  }
  if (Array.isArray(val)) return '[' + val.map((x) => format_value(x, seen)).join(', ') + ']';
  switch (typeof val) {
    case 'string':
      return '"' + val.replace(escapePattern, (c) => escapes[c]) + '"';
    case 'boolean':
    case 'undefined':
      return String(val);
    case 'number':
      return Object.is(val, -0) ? '-0' : String(val);
    case 'bigint':
      return String(val) + 'n';
    case 'object':
      if (val === null) return 'null';
    // Upstream formats DOM nodes here, which these suites do not use
    // falls through
    default:
      try {
        const s = String(val);
        return typeof val + ' "' + (s.length > 1000 ? s.substring(0, 997) + '...' : s) + '"';
      } catch (e) {
        return '[stringifying object threw ' + String(e) + ' with type ' + typeof e + ']';
      }
  }
}

function assert(ok: boolean, fn: string, description: any, error: string, subs: any = {}) {
  if (ok) return;
  const text = error.replace(/\$\{(\w+)\}/g, (_, key) => format_value(subs[key]));
  throw new AssertionError(`${fn}: ${description ? description + ' ' : ''}${text}`);
}

function same_value(x: any, y: any): boolean {
  if (Number.isNaN(y)) return Number.isNaN(x);
  if (x === 0 && y === 0) return 1 / x === 1 / y;
  return x === y;
}

function throws(kind: string, func: () => unknown, d: any, check: (e: any) => void) {
  try {
    func();
  } catch (e) {
    if (e instanceof AssertionError) throw e;
    return check(e);
  }
  assert(false, kind, d, '${func} did not throw', { func });
}

const throwsJs = (kind: string, ctor: any, func: () => unknown, d?: any) =>
  throws(kind, func, d, (e) => {
    assert(typeof e === 'object' && e !== null, kind, d, '${func} threw ${e}, not an object', {
      func,
      e,
    });
    const error = '${func} threw ${actual} (${an}) expected instance of ${expected} (${en})';
    const subs = { func, actual: e, an: e.name, expected: ctor, en: ctor.name };
    assert(e.constructor === ctor && e.name === ctor.name, kind, d, error, subs);
  });

const throwsExactly = (kind: string, exception: any, func: () => unknown, d?: any) =>
  throws(kind, func, d, (e) => {
    const error = '${func} threw ${e} but we expected it to throw ${exception}';
    assert(same_value(e, exception), kind, d, error, { func, e, exception });
  });

// Upstream also accepts legacy numeric codes and a DOMException from another realm; not needed here.
const throwsDom = (kind: string, type: string, func: () => unknown, d?: any) =>
  throws(kind, func, d, (e) => {
    const error = '${func} threw ${e} that is not a DOMException ${type}';
    assert(e?.name === type, kind, d, error, { func, e, type });
  });

/** An assert of the form `kind(actual, expected, description)`. */
const compare =
  (kind: string, error: string, ok: (actual: any, expected: any) => boolean) =>
  (actual: any, expected: any, d?: any) =>
    assert(ok(actual, expected), kind, d, error, { actual, expected });

const sameType = (actual: any, expected: any) => typeof actual === typeof expected;

const asserts = {
  assert_true: (actual: any, d?: any) =>
    assert(actual === true, 'assert_true', d, 'expected true got ${actual}', { actual }),
  assert_false: (actual: any, d?: any) =>
    assert(actual === false, 'assert_false', d, 'expected false got ${actual}', { actual }),
  assert_equals(actual: any, expected: any, d?: any) {
    const error = sameType(actual, expected)
      ? 'expected ${expected} but got ${actual}'
      : `expected (${typeof expected}) \${expected} but got (${typeof actual}) \${actual}`;
    assert(same_value(actual, expected), 'assert_equals', d, error, { expected, actual });
  },
  assert_not_equals: compare('assert_not_equals', 'got disallowed value ${actual}', (a, e) => {
    return !same_value(a, e);
  }),
  assert_array_equals(actual: any, expected: any, d?: any) {
    const kind = 'assert_array_equals';
    const isArray = typeof actual === 'object' && actual !== null && 'length' in actual;
    assert(isArray, kind, d, 'value is ${actual}, expected array', { actual });
    const error =
      'lengths differ, expected array ${expected} length ${el}, got ${actual} length ${al}';
    const subs = { expected, el: expected.length, actual, al: actual.length };
    assert(actual.length === expected.length, kind, d, error, subs);
    for (let i = 0; i < actual.length; i++) {
      const has = (array: any) =>
        Object.prototype.hasOwnProperty.call(array, i) ? 'present' : 'missing';
      const presence = { i, expected: has(expected), actual: has(actual) };
      const missing = 'expected property ${i} to be ${expected} but was ${actual}';
      assert(presence.expected === presence.actual, kind, d, missing, presence);
      const subs = { i, expected: expected[i], actual: actual[i] };
      const error = 'expected property ${i} to be ${expected} but got ${actual}';
      assert(same_value(expected[i], actual[i]), kind, d, error, subs);
    }
  },
  assert_approx_equals(actual: any, expected: any, epsilon: number, d?: any) {
    const error = 'expected ${expected} +/- ${epsilon} but got ${actual}';
    const subs = { expected, epsilon, actual };
    assert(Math.abs(actual - expected) <= epsilon, 'assert_approx_equals', d, error, subs);
  },
  assert_less_than: compare(
    'assert_less_than',
    'expected a number less than ${expected} but got ${actual}',
    (a, e) => sameType(a, e) && a < e
  ),
  assert_greater_than: compare(
    'assert_greater_than',
    'expected a number greater than ${expected} but got ${actual}',
    (a, e) => sameType(a, e) && a > e
  ),
  assert_in_array: compare('assert_in_array', 'value ${actual} not in array ${expected}', (a, e) =>
    e.includes(a)
  ),
  assert_regexp_match: compare(
    'assert_regexp_match',
    'expected ${expected} but got ${actual}',
    (a, e) => e.test(a)
  ),
  assert_own_property: compare(
    'assert_own_property',
    'expected property ${expected} missing',
    (o, p) => Object.prototype.hasOwnProperty.call(o, p)
  ),
  assert_class_string: (object: any, classString: string, d?: any) =>
    compare('assert_class_string', 'expected ${expected} but got ${actual}', same_value)(
      Object.prototype.toString.call(object),
      '[object ' + classString + ']',
      d
    ),
  assert_unreached: (d?: any) => assert(false, 'assert_unreached', d, 'Reached unreachable code'),
  assert_throws_js: (c: any, f: () => unknown, d?: any) => throwsJs('assert_throws_js', c, f, d),
  assert_throws_exactly: (e: any, f: () => unknown, d?: any) =>
    throwsExactly('assert_throws_exactly', e, f, d),
  assert_throws_dom: (type: string, f: () => unknown, d?: any) =>
    throwsDom('assert_throws_dom', type, f, d),
};

// Upstream times out a whole file after 10 s. Here each test gets its own timeout, below the
// test-suite's 10 s jasmine timeout, so a hang fails the WPT test and can be listed as expected.
const TEST_TIMEOUT_MS = 5000;

/** The `t` object WPT passes to test bodies. */
class WptTest {
  // A separate flag, because a test can fail with any value, `null` and `undefined` included.
  failed = false;
  error: unknown;
  finished = false;
  private cleanups: (() => unknown)[] = [];
  private resolveDone!: () => void;
  readonly whenDone = new Promise<void>((resolve) => (this.resolveDone = resolve));

  constructor(readonly name: string) {}

  step(func: (...args: any[]) => any, thisObj?: any, ...args: any[]) {
    if (this.finished) return;
    try {
      return func.apply(thisObj === undefined ? this : thisObj, args);
    } catch (e) {
      this.fail(e);
    }
  }
  step_func =
    (func: (...args: any[]) => any, thisObj?: any) =>
    (...args: any[]) =>
      this.step(func, thisObj, ...args);
  step_func_done =
    (func?: (...args: any[]) => any, thisObj?: any) =>
    (...args: any[]) => {
      if (func) this.step(func, thisObj, ...args);
      this.done();
    };
  unreached_func = (description?: any) =>
    this.step_func(() => asserts.assert_unreached(description));
  add_cleanup = (fn: () => unknown) => {
    this.cleanups.push(fn);
  };
  // Like upstream, cleanups run as soon as the test finishes, because a test that patches a
  // builtin (`String.prototype[Symbol.iterator]` in `Blob-constructor`) must not leak into the next.
  done = () => {
    if (this.finished) return;
    this.finished = true;
    const cleanups = this.cleanups.map(async (cleanup) => cleanup());
    Promise.allSettled(cleanups).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected' && !this.failed) {
          this.failed = true;
          this.error = result.reason;
        }
      }
      this.resolveDone();
    });
  };
  fail(error: unknown) {
    if (this.finished) return;
    this.failed = true;
    this.error = error;
    this.done();
  }
  /** Rethrows the first failure once the test and its cleanups finish, to fail the jasmine spec. */
  async settle() {
    // Like upstream's `Test.timeout()`, a timeout finishes the test, so its cleanups still run.
    const timer = setTimeout(() => this.fail(new Error('Test timed out')), TEST_TIMEOUT_MS);
    try {
      await this.whenDone;
    } finally {
      clearTimeout(timer);
    }
    if (this.failed) throw this.error;
  }
  /** Upstream reports a body that returns a value as a harness error; here it fails the test. */
  checkReturnValue(kind: string, value: any) {
    if (value === undefined) return;
    let message = `Test named "${this.name}" passed a function to \`${kind}\` that returned a value.`;
    if (typeof value?.then === 'function') {
      message += ' Consider using `promise_test` instead when using Promises or async/await.';
    }
    this.fail(new Error(message));
  }
}

/** Registers a WPT test as one jasmine spec. Set while a vendored file registers its tests. */
let register: ((name: string, body: () => Promise<void>) => void) | null = null;

function testharnessGlobals() {
  const add = (name: string, body: () => Promise<void>) => {
    if (!register) throw new Error(`WPT test "${name}" registered outside of a vendored file`);
    register(name, body);
  };
  return {
    ...asserts,
    AssertionError,
    format_value,
    // Upstream runs the body at once, and some bodies register more tests (`Blob-slice`).
    test(func: (t: WptTest) => void, name: string) {
      const t = new WptTest(name);
      add(name, () => t.settle());
      t.checkReturnValue('test', t.step(func, t, t));
      t.done();
    },
    promise_test(func: (t: WptTest) => PromiseLike<unknown>, name: string) {
      add(name, async () => {
        const t = new WptTest(name);
        const promise = t.step(func, t, t);
        if (!t.finished && typeof promise?.then !== 'function') {
          t.fail(new AssertionError("promise_test: test body must return a 'thenable' object"));
        }
        // Not awaited, so the timeout in `settle()` also covers a promise that never settles.
        if (!t.finished) promise.then(t.done, (e: unknown) => t.fail(e));
        return t.settle();
      });
    },
    // Upstream runs the first step at once, so a file can call `t.step()` before the spec starts.
    async_test(funcOrName: ((t: WptTest) => void) | string, maybeName?: string) {
      const func = typeof funcOrName === 'function' ? funcOrName : null;
      const name = (func ? maybeName : funcOrName) as string;
      const t = new WptTest(name);
      if (func) t.checkReturnValue('async_test', t.step(func, t, t));
      add(name, () => t.settle());
      return t;
    },
    setup: (funcOrOptions: unknown) => typeof funcOrOptions === 'function' && funcOrOptions(),
    done: () => {},
    promise_rejects_js: (t: WptTest, c: any, p: Promise<unknown>, d?: any) =>
      rejects(t, p, d, (e) => throwsJs('promise_rejects_js', c, rethrow(e), d)),
    promise_rejects_exactly: (t: WptTest, ex: any, p: Promise<unknown>, d?: any) =>
      rejects(t, p, d, (e) => throwsExactly('promise_rejects_exactly', ex, rethrow(e), d)),
    promise_rejects_dom: (t: WptTest, type: string, p: Promise<unknown>, d?: any) =>
      rejects(t, p, d, (e) => throwsDom('promise_rejects_dom', type, rethrow(e), d)),
  };
}

const rethrow = (e: unknown) => () => {
  throw e;
};

function rejects(t: WptTest, promise: Promise<unknown>, d: any, check: (e: unknown) => void) {
  return Promise.resolve(promise)
    .then(t.unreached_func('Should have rejected: ' + d))
    .catch(check);
}

let uninstallActive: (() => void) | null = null;

/**
 * Defines the testharness globals, then calls `registerFiles`. Returns a function that removes the
 * globals and the ones the vendored support files added while registering (such as
 * `self.test_blob`), and nothing that other suites add later.
 *
 * Jasmine registers every selected suite before it runs any spec, and the suite removes the globals
 * in its `afterAll`, so a suite that runs earlier in the same run also sees them.
 */
export function installWptGlobals(registerFiles: () => void): () => void {
  // A cancelled run never reaches its `afterAll`, so drop what it left behind first.
  uninstallActive?.();
  const g = globalThis as any;
  const before = new Set(Object.getOwnPropertyNames(g));
  const harness = testharnessGlobals();
  const shadowed = Object.keys(harness).filter((name) => before.has(name));
  if (shadowed.length) throw new Error(`WPT harness would shadow globals: ${shadowed.join(', ')}`);
  if (g.self === undefined) g.self = g;
  Object.assign(g, harness);
  registerFiles();
  const added = Object.getOwnPropertyNames(g).filter((name) => !before.has(name));
  uninstallActive = () => {
    added.forEach((name) => delete g[name]);
    uninstallActive = null;
  };
  return uninstallActive;
}

/** Known failures of one platform: `{ "<file>": { "<test name>": "fail" } }`. */
export type WptExpectations = Record<string, Record<string, 'fail'>>;

export type WptCounts = { total: number; passed: number; expectedFailures: number };

/**
 * Runs one vendored file inside its own `describe`, one `it` per WPT test, and logs the file's
 * score when it finishes. A test listed in `expected` that fails is marked pending, so it counts
 * neither as passed nor as failed; one that passes fails, so the list cannot go stale.
 */
export function describeWptFile(
  t: JasmineInterface,
  file: WptFile,
  expected: Record<string, 'fail'> = {},
  counts: WptCounts = { total: 0, passed: 0, expectedFailures: 0 }
): WptCounts {
  t.describe(file.path, () => {
    const names = new Set<string>();
    register = (name, body) => {
      // Upstream reports a duplicate name as a harness error, so it fails the whole file.
      if (names.has(name)) throw new Error(`duplicate test name: ${name}`);
      names.add(name);
      counts.total++;
      t.it(name, async () => {
        let failed = false;
        let error: unknown;
        try {
          await body();
        } catch (e) {
          failed = true;
          error = e;
        }
        if (expected[name] !== 'fail') {
          if (failed) throw error;
          counts.passed++;
        } else if (failed) {
          counts.expectedFailures++;
          t.pending(`expected failure: ${String((error as any)?.message ?? error)}`);
        } else {
          throw new Error('unexpected pass: remove it from expectations');
        }
      });
    };
    try {
      file.scripts.forEach((script) => script());
      file.run();
    } catch (e) {
      // Upstream reports this as a harness error; tests registered before the throw still run.
      // Not a WPT test, so it is not counted in the file's total.
      t.it('(harness) top-level script', () => {
        throw e;
      });
    } finally {
      register = null;
    }
    const stale = Object.keys(expected).filter((name) => !names.has(name));
    if (stale.length) {
      t.it('(harness) expectations name existing tests', () => {
        throw new Error(`no such tests, remove them from expectations: ${stale.join(', ')}`);
      });
    }
    t.afterAll(() => {
      const { passed, total, expectedFailures } = counts;
      console.log(`[WPT] ${file.path}: ${passed}/${total} (${expectedFailures} expected failures)`);
    });
  });
  return counts;
}
