import * as expoBlobEntry from 'expo/blob';

import * as expoBlob from '..';

describe('expo-blob', () => {
  // The implementation now lives in the `expo` package. `expo-blob` must hand out the very
  // same class object, otherwise an app that mixes both imports would end up with two
  // unrelated Blob classes and `instanceof` would break across them.
  it('re-exports the same Blob class as expo/blob', () => {
    expect(expoBlob.Blob).toBe(expoBlobEntry.Blob);
  });

  it('re-exports isBlobLike', () => {
    expect(expoBlob.isBlobLike).toBe(expoBlobEntry.isBlobLike);
  });
});
