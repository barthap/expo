import { Platform } from 'expo-modules-core';

import type { JasmineInterface } from '../../types';
import {
  describeWptFile,
  installWptGlobals,
  type WptCounts,
  type WptExpectations,
  type WptFile,
} from './harness';

export const name = 'WPT FileAPI';
export const route = 'wptfileapi';

// The WPT `FileAPI/blob` and `FileAPI/file` suites, vendored by `scripts/vendor-wpt.mjs`.
const files: WptFile[] = require('./vendor').default;

const expectations: Record<string, WptExpectations> = {
  android: require('./expectations/android.json'),
  ios: require('./expectations/ios.json'),
  web: require('./expectations/web.json'),
};

export function test(t: JasmineInterface) {
  const expected = expectations[Platform.OS] ?? {};
  t.describe(name, () => {
    let scores: WptCounts[] = [];
    const uninstall = installWptGlobals(() => {
      scores = files.map((file) => describeWptFile(t, file, expected[file.path]));
    });
    const unknownFiles = Object.keys(expected).filter(
      (path) => !files.some((f) => f.path === path)
    );
    if (unknownFiles.length) {
      t.it('(harness) expectations name vendored files', () => {
        throw new Error(`no such files, remove them from expectations: ${unknownFiles.join(', ')}`);
      });
    }
    t.afterAll(() => {
      uninstall();
      const sum = (key: keyof WptCounts) => scores.reduce((total, s) => total + s[key], 0);
      const failures = sum('expectedFailures');
      console.log(`[WPT] total: ${sum('passed')}/${sum('total')} (${failures} expected failures)`);
    });
  });
}
