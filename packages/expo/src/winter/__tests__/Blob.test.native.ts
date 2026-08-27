// Tests the global `Blob` and `File` overrides installed by the native winter runtime.
// The `ExpoBlob` native module resolves to the in-memory mock in `expo/mocks/ExpoBlob.ts`
// via jest-expo's `requireNativeModule` mock.

// Installs the globals as a side effect.
import '../runtime';
import { Blob as ExpoBlob } from '../../blob';
import { File as ExpoFile } from '../File';

describe('global installation', () => {
  it('replaces the global Blob with the Expo implementation', () => {
    expect(globalThis.Blob).toBe(ExpoBlob);
    expect((globalThis.Blob as any)[Symbol.for('expo.builtin')]).toBe(true);
  });

  it('replaces the global File with the W3C File that extends the global Blob', () => {
    expect(globalThis.File).toBe(ExpoFile);
    expect((globalThis.File as any)[Symbol.for('expo.builtin')]).toBe(true);
    expect(Object.getPrototypeOf(globalThis.File)).toBe(globalThis.Blob);
  });
});

describe('Blob constructor', () => {
  it('creates an empty Blob with no arguments', () => {
    const blob = new ExpoBlob();
    expect(blob.size).toBe(0);
    expect(blob.type).toBe('');
  });

  it('throws when called without new', () => {
    // @ts-expect-error: intentionally calling without new
    expect(() => ExpoBlob()).toThrow(TypeError);
  });

  it('has constructor length 0 like the built-in Blob', () => {
    expect(ExpoBlob.length).toBe(0);
  });

  it('accepts string, ArrayBuffer, and TypedArray parts', async () => {
    const blob = new ExpoBlob(['ab', new TextEncoder().encode('cd').buffer, new Uint8Array([101])]);
    expect(await blob.text()).toBe('abcde');
  });
});

describe('Blob Symbol.toStringTag', () => {
  it('is reported by Object.prototype.toString', () => {
    expect(Object.prototype.toString.call(new ExpoBlob())).toBe('[object Blob]');
  });
});

describe('Blob Symbol.hasInstance', () => {
  it('matches real Blob instances', () => {
    expect(new ExpoBlob(['x']) instanceof ExpoBlob).toBe(true);
  });

  it('matches sliced Blobs', () => {
    expect(new ExpoBlob(['abc']).slice(0, 1) instanceof ExpoBlob).toBe(true);
  });

  it('does not match primitives', () => {
    expect((null as any) instanceof ExpoBlob).toBe(false);
    expect((undefined as any) instanceof ExpoBlob).toBe(false);
    expect((42 as any) instanceof ExpoBlob).toBe(false);
    expect(('blob' as any) instanceof ExpoBlob).toBe(false);
    expect((true as any) instanceof ExpoBlob).toBe(false);
  });

  it('does not match plain or partially Blob-shaped objects', () => {
    expect(({} as any) instanceof ExpoBlob).toBe(false);
    expect(({ arrayBuffer: () => {}, size: 0 } as any) instanceof ExpoBlob).toBe(false);
  });

  it('matches React Native built-in Blobs, which lack arrayBuffer/text', () => {
    // Shape of a Blob produced by RN XHR (responseType: 'blob') or WebSocket (binaryType: 'blob')
    const rnBlob = {
      data: { blobId: 'e7b1…', offset: 0, size: 3 },
      size: 3,
      type: 'application/octet-stream',
      slice: () => rnBlob,
    };
    expect((rnBlob as any) instanceof ExpoBlob).toBe(true);
  });

  it('does not match objects with a non-blob data property', () => {
    expect(({ data: {}, size: 0, slice: () => {} } as any) instanceof ExpoBlob).toBe(false);
    expect(({ data: { blobId: 42 }, size: 0, slice: () => {} } as any) instanceof ExpoBlob).toBe(
      false
    );
  });

  it('matches duck-typed Blob-like objects, like expo-file-system File', () => {
    const fileLike = {
      arrayBuffer: async () => new ArrayBuffer(0),
      slice: () => fileLike,
      text: async () => '',
      size: 0,
      type: 'text/plain',
    };
    expect((fileLike as any) instanceof ExpoBlob).toBe(true);
  });
});

describe('Blob duck-typed parts', () => {
  it('rejects duck-typed Blob-like parts with a descriptive error instead of stringifying them', () => {
    const fileLike = {
      arrayBuffer: async () => new ArrayBuffer(4),
      slice: () => fileLike,
      text: async () => 'true',
      size: 4,
      type: 'text/plain',
    };
    expect(() => new ExpoBlob([fileLike as any])).toThrow(/bytes\(\)/);
  });
});

describe('W3C File global', () => {
  it('extends Blob and carries name and lastModified', async () => {
    const file = new ExpoFile(['hello'], 'greeting.txt', {
      type: 'text/plain',
      lastModified: 1234567890,
    });
    expect(file instanceof ExpoBlob).toBe(true);
    expect(file.name).toBe('greeting.txt');
    expect(file.lastModified).toBe(1234567890);
    expect(file.size).toBe(5);
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('hello');
  });

  it('defaults lastModified to now', () => {
    const before = Date.now();
    const file = new ExpoFile([], 'empty.bin');
    expect(file.lastModified).toBeGreaterThanOrEqual(before);
    expect(file.lastModified).toBeLessThanOrEqual(Date.now());
  });

  it('coerces the name to a string', () => {
    // @ts-expect-error: intentionally passing a non-string name
    expect(new ExpoFile([], 42).name).toBe('42');
  });

  it('requires the name argument like the spec constructor', () => {
    // @ts-expect-error: intentionally omitting arguments
    expect(() => new ExpoFile()).toThrow(TypeError);
  });

  // Unlike in the Blob constructor, `fileBits` is required, so `undefined` is not an empty list.
  // https://w3c.github.io/FileAPI/#file-constructor
  it('requires the fileBits argument like the spec constructor', () => {
    // @ts-expect-error: intentionally passing undefined fileBits
    expect(() => new ExpoFile(undefined, 'a')).toThrow(TypeError);
  });

  // `lastModified` is a WebIDL `long long`, so code that passes e.g. a fractional `Date.now()`
  // offset or a numeric string gets the same timestamp it would get on the web.
  // https://webidl.spec.whatwg.org/#es-long-long
  it.each([
    [null, 0],
    [1.9, 1],
    [-1.9, -1],
    [NaN, 0],
    [Infinity, 0],
    ['123', 123],
  ])('converts lastModified %p to %p like a WebIDL long long', (lastModified, expected) => {
    const file = new ExpoFile([], 'a', { lastModified: lastModified as any });
    expect(file.lastModified).toBe(expected);
  });

  it('defaults lastModified to now when it is undefined', () => {
    const before = Date.now();
    const file = new ExpoFile([], 'a', { lastModified: undefined });
    expect(file.lastModified).toBeGreaterThanOrEqual(before);
    expect(file.lastModified).toBeLessThanOrEqual(Date.now());
  });

  it('matches real File instances', () => {
    expect(new ExpoFile([], 'x') instanceof ExpoFile).toBe(true);
    expect(new ExpoBlob([]) instanceof ExpoFile).toBe(false);
  });

  it('matches React Native built-in Files via Symbol.hasInstance', () => {
    const rnFile = {
      data: { blobId: 'e7b1…', offset: 0, size: 3 },
      size: 3,
      type: 'image/png',
      slice: () => rnFile,
      name: 'photo.png',
      lastModified: 0,
    };
    expect((rnFile as any) instanceof ExpoFile).toBe(true);
    // Without a name it is only a Blob, not a File
    const { name: _name, ...rnBlob } = rnFile;
    expect((rnBlob as any) instanceof ExpoFile).toBe(false);
  });

  it('is reported as [object File]', () => {
    expect(Object.prototype.toString.call(new ExpoFile([], 'x'))).toBe('[object File]');
  });

  // File inherits `toString()` from the Expo Blob, which would otherwise report it as a Blob.
  it('stringifies as [object File]', () => {
    const file = new ExpoFile([], 'x');
    expect(file.toString()).toBe('[object File]');
    expect(String(file)).toBe('[object File]');
  });

  describe('subclasses', () => {
    // Same reasoning as for Blob subclasses: the inherited static `Symbol.hasInstance` must not
    // duck-type, or a plain File would claim to be an instance of a class it knows nothing about.
    class SubFile extends ExpoFile {}

    it('does not report a plain File as an instance of a subclass', () => {
      expect(new ExpoFile([], 'a') instanceof SubFile).toBe(false);
    });

    it('reports a subclass instance as an instance of both the subclass and File', () => {
      const sub = new SubFile([], 'a');
      expect(sub instanceof SubFile).toBe(true);
      expect(sub instanceof ExpoFile).toBe(true);
    });
  });
});

// `name` and `lastModified` are readonly attributes in the File API. They must not be
// writable own properties, because anything holding a reference to the File could then
// rewrite its metadata — see the FormData tests below.
// https://w3c.github.io/FileAPI/#file-attrs
describe('W3C File readonly metadata', () => {
  it('ignores assignment to name', () => {
    const file = new ExpoFile(['x'], 'original.txt');
    try {
      // @ts-expect-error: intentionally assigning to a readonly property
      file.name = 'other.txt';
    } catch {
      // Web throws here in strict mode and silently ignores it otherwise. Either is fine,
      // as long as the value does not change.
    }
    expect(file.name).toBe('original.txt');
  });

  it('ignores assignment to lastModified', () => {
    const file = new ExpoFile(['x'], 'original.txt', { lastModified: 1234567890 });
    try {
      // @ts-expect-error: intentionally assigning to a readonly property
      file.lastModified = 0;
    } catch {
      // See above.
    }
    expect(file.lastModified).toBe(1234567890);
  });

  it('does not expose name and lastModified as writable own properties', () => {
    const file = new ExpoFile(['x'], 'original.txt');
    for (const key of ['name', 'lastModified']) {
      expect(Object.getOwnPropertyDescriptor(file, key)?.writable).not.toBe(true);
    }
  });
});

// `expo/fetch` and React Native both build the multipart `content-disposition` filename by
// reading `part.name` off the appended value, so a File whose `name` can be rewritten leaks
// one entry's filename into another.
describe('W3C File in React Native FormData', () => {
  const { installFormDataPatch } = jest.requireActual('../FormData');
  const RNFormData = require('react-native/Libraries/Network/FormData').default;
  const ExpoFormData = installFormDataPatch(RNFormData);

  it('keeps the File name when appended with a different filename', () => {
    const file = new ExpoFile(['x'], 'original.txt', { type: 'text/plain' });
    const formData = new ExpoFormData();
    formData.append('upload', file, 'override.txt');

    expect(file.name).toBe('original.txt');
  });

  it('does not let a second append overwrite the first entry filename', () => {
    const file = new ExpoFile(['x'], 'original.txt', { type: 'text/plain' });
    const formData = new ExpoFormData();
    formData.append('first', file, 'a.txt');
    formData.append('second', file, 'b.txt');

    const filenames = formData
      .getParts()
      .map((part: { headers: Record<string, string> }) => part.headers['content-disposition']);

    // Both parts point at the same File, so neither may have been rewritten to 'b.txt'.
    expect(filenames[0]).toContain('filename="original.txt"');
    expect(filenames[1]).toContain('filename="original.txt"');
    expect(file.name).toBe('original.txt');
  });
});
