import type { JasmineInterface } from '../../types';
import { describeWptFile, installWptGlobals, type WptFile } from './harness';

export const name = 'WPT FileAPI';
export const route = 'wptfileapi';

// The WPT `FileAPI/blob` and `FileAPI/file` suites, vendored by `scripts/vendor-wpt.mjs`.
const files: WptFile[] = require('./vendor').default;

export function test(t: JasmineInterface) {
  const uninstall = installWptGlobals();
  t.describe(name, () => {
    t.afterAll(uninstall);
    files.forEach((file) => describeWptFile(t, file));
  });
}
