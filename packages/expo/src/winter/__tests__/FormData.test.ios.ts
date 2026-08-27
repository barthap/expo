/* eslint-disable no-global-assign */
import { Blob as ExpoBlob } from '../../blob';
import { File as ExpoFile } from '../File';
import type { ExpoFormData, ExpoFormDataEntry } from '../FormData';

const { installFormDataPatch } = jest.requireActual('../FormData');
const jestFormDataPolyfill = FormData;

/** Reads the internal entries, including the per-entry filename that `entries()` hides. */
function getFormDataEntries(formData: ExpoFormData): ExpoFormDataEntry[] {
  return (formData as unknown as { _parts: ExpoFormDataEntry[] })._parts;
}

// NOTE(@kitten): We need to overload the `append` method additions on the NodeJS type as well,
// since it'll be available in this TypeScript environment
declare global {
  interface FormData {
    // React Native proprietary local file
    append(name: string, value: { uri: string; name?: string; type?: string }): void;
    set(name: string, value: { uri: string; name?: string; type?: string }): void;
  }
}

beforeAll(() => {
  FormData = installFormDataPatch(require('react-native/Libraries/Network/FormData').default);
});

afterAll(() => {
  FormData = jestFormDataPolyfill;
});

describe('FormData', () => {
  it(`asserts min arguments`, () => {
    const a = new FormData();
    expect(() =>
      // @ts-expect-error: Testing invalid usage
      a.set(0)
    ).toThrow("Failed to execute 'set' on 'FormData': 2 arguments required, but only 1 present.");
    expect(() =>
      // @ts-expect-error: Testing invalid usage
      a.has()
    ).toThrow("Failed to execute 'has' on 'FormData': 1 argument required, but only 0 present.");
    expect(() =>
      // @ts-expect-error: Testing invalid usage
      a.get()
    ).toThrow("Failed to execute 'get' on 'FormData': 1 argument required, but only 0 present.");
    expect(() =>
      // @ts-expect-error: Testing invalid usage
      a.delete()
    ).toThrow("Failed to execute 'delete' on 'FormData': 1 argument required, but only 0 present.");
    expect(() =>
      // @ts-expect-error: Testing invalid usage
      a.forEach()
    ).toThrow(
      "Failed to execute 'forEach' on 'FormData': 1 argument required, but only 0 present."
    );
  });

  describe('setters', () => {
    it(`supports set`, () => {
      const a = new FormData();
      a.append('a', 'b');
      a.set('a', 'd');

      expect(a.get('a')).toBe('d');
      a.delete('a');
      expect(a.get('a')).toBe(null);
    });

    it(`supports react-native local uri`, () => {
      const a = new FormData() as ExpoFormData;
      a.append('a', { uri: 'file:///path/to/test.jpg', type: 'image/jpeg', name: 'test.jpg' });
      expect(a.get('a')).toEqual({
        uri: 'file:///path/to/test.jpg',
        type: 'image/jpeg',
        name: 'test.jpg',
      });
    });
  });

  describe('entry filenames', () => {
    it(`uses the filename argument and leaves the value untouched`, () => {
      const a = new FormData() as ExpoFormData;
      const file = new ExpoFile(['hello'], 'original.txt');
      a.append('a', file as unknown as Blob, 'override.txt');

      expect(getFormDataEntries(a)).toEqual([['a', file, 'override.txt']]);
      // The caller's File must not be renamed by appending it.
      expect(file.name).toBe('original.txt');
    });

    it(`does not throw when appending a File with a filename`, () => {
      // Regression: the filename used to be smuggled through `value.name`, which throws
      // `TypeError: Cannot assign to property 'name' which has only a getter` in strict mode
      // now that `File.name` is a getter-only prototype accessor.
      const a = new FormData() as ExpoFormData;
      const file = new ExpoFile(['hello'], 'original.txt');
      expect(() => a.append('a', file as unknown as Blob, 'override.txt')).not.toThrow();
    });

    it(`keeps per-entry filenames when the same File is appended twice`, () => {
      const a = new FormData() as ExpoFormData;
      const file = new ExpoFile(['hello'], 'original.txt');
      a.append('a', file as unknown as Blob, 'first.txt');
      a.append('b', file as unknown as Blob, 'second.txt');

      expect(getFormDataEntries(a)).toEqual([
        ['a', file, 'first.txt'],
        ['b', file, 'second.txt'],
      ]);
      expect(file.name).toBe('original.txt');
    });

    it(`falls back to the File name when no filename is given`, () => {
      const a = new FormData() as ExpoFormData;
      const file = new ExpoFile(['hello'], 'original.txt');
      a.append('a', file as unknown as Blob);

      expect(getFormDataEntries(a)).toEqual([['a', file, 'original.txt']]);
    });

    it(`falls back to "blob" for a Blob without a name`, () => {
      const a = new FormData() as ExpoFormData;
      const blob = new ExpoBlob(['hello']);
      a.append('a', blob as unknown as Blob);

      expect(getFormDataEntries(a)).toEqual([['a', blob, 'blob']]);
    });

    it(`carries the filename through set`, () => {
      const a = new FormData() as ExpoFormData;
      const file = new ExpoFile(['hello'], 'original.txt');
      a.append('a', 'placeholder');
      a.set('a', file as unknown as Blob, 'override.txt');

      expect(getFormDataEntries(a)).toEqual([['a', file, 'override.txt']]);
      expect(file.name).toBe('original.txt');
    });

    it(`does not expose the filename through entries`, () => {
      const a = new FormData() as ExpoFormData;
      const file = new ExpoFile(['hello'], 'original.txt');
      a.append('a', file as unknown as Blob, 'override.txt');

      expect([...a.entries()]).toEqual([['a', file]]);
    });
  });

  describe('getters', () => {
    it(`supports has`, () => {
      const a = new FormData();
      a.append('a', 'b');
      a.append('c', 'd');

      expect(a.has('a')).toBe(true);
      expect(a.has('b')).toBe(false);
    });

    it(`supports get`, () => {
      const a = new FormData();
      a.append('a', 'b');
      a.append('c', 'd');

      expect(a.get('a')).toBe('b');
      expect(a.get('b')).toBe(null);
    });
  });

  describe('forEach', () => {
    it(`works`, () => {
      const a = new FormData();
      a.append('a', 'b');
      a.append('c', 'd');
      const forEach = jest.fn();
      a.forEach(forEach);
      expect(forEach).toHaveBeenCalledTimes(2);
    });

    it(`asserts getting too few arguments`, () => {
      const a = new FormData();
      expect(() =>
        // @ts-expect-error: Testing invalid usage
        a.forEach()
      ).toThrow(
        `Failed to execute 'forEach' on 'FormData': 1 argument required, but only 0 present.`
      );
    });

    it(`does not assert forEach getting too many arguments`, () => {
      const a = new FormData();
      // @ts-expect-error: expected invalid usage
      a.forEach(() => {}, 1, 2);
    });

    it(`asserts forEach callback`, () => {
      const a = new FormData();
      expect(() =>
        // @ts-expect-error: Testing invalid usage
        a.forEach(0)
      ).toThrow(
        `Failed to execute 'forEach' on 'FormData': parameter 1 is not of type 'Function'.`
      );
    });
  });

  describe('iterators', () => {
    it('supports iteration', () => {
      const a = new FormData();
      a.append('a', 'b');
      const fn = jest.fn();
      for (const [key, value] of a) {
        fn(key, value);
        expect(key).toBe('a');
        expect(value).toBe('b');
      }
      expect(fn).toHaveBeenCalledTimes(1);

      const keysFn = jest.fn();
      for (const key of a.keys()) {
        keysFn(key);
        expect(key).toBe('a');
      }
      expect(keysFn).toHaveBeenCalledTimes(1);

      const valuesFn = jest.fn();
      for (const value of a.values()) {
        valuesFn(value);
        expect(value).toBe('b');
      }
      expect(valuesFn).toHaveBeenCalledTimes(1);

      const entriesFn = jest.fn();
      for (const [key, value] of a.entries()) {
        entriesFn(key, value);
        expect(key).toBe('a');
        expect(value).toBe('b');
      }
      expect(entriesFn).toHaveBeenCalledTimes(1);
    });
  });
});
