// Tests call the exported functions directly instead of the globals, so they keep testing this
// implementation on Node versions that ship the methods natively.
// Expected values follow the steps of https://tc39.es/proposal-arraybuffer-base64/spec/
import {
  fromBase64,
  fromHex,
  installUint8ArrayBase64,
  setFromBase64,
  setFromHex,
  toBase64,
  toHex,
} from '../Uint8ArrayBase64';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const decode = (string: unknown, options?: unknown) =>
  (fromBase64 as (...args: unknown[]) => Uint8Array)(string, options);
const encode = (array: unknown, options?: unknown) =>
  (toBase64 as (this: unknown, ...args: unknown[]) => string).call(array, options);
const setBase64 = (array: Uint8Array, string: unknown, options?: unknown) =>
  (setFromBase64 as (this: unknown, ...args: unknown[]) => { read: number; written: number }).call(
    array,
    string,
    options
  );
const setHex = (array: unknown, string: unknown) =>
  (setFromHex as (this: unknown, string: unknown) => { read: number; written: number }).call(
    array,
    string
  );
// Options whose property reads are recorded in `reads`, to check which options are read and in
// which order.
const recordReads = (reads: string[], values: Record<string, unknown> = {}) =>
  new Proxy(values, {
    get: (target, key) => {
      reads.push(String(key));
      return target[key as string];
    },
  });
// Node can detach a buffer with `transfer`. Hermes cannot, so there the check never fires.
const itDetaches = typeof (ArrayBuffer.prototype as any).transfer === 'function' ? it : it.skip;
const detach = (array: Uint8Array) => (array.buffer as any).transfer();

describe('toBase64', () => {
  it('encodes with padding by default (RFC 4648 section 4)', () => {
    expect(encode(text(''))).toBe('');
    expect(encode(text('f'))).toBe('Zg==');
    expect(encode(text('fo'))).toBe('Zm8=');
    expect(encode(text('foo'))).toBe('Zm9v');
    expect(encode(text('foobar'))).toBe('Zm9vYmFy');
  });

  it('uses "-" and "_" for the base64url alphabet (RFC 4648 section 5)', () => {
    expect(encode(bytes(0xfb, 0xff, 0xbf))).toBe('+/+/');
    expect(encode(bytes(0xfb, 0xff, 0xbf), { alphabet: 'base64url' })).toBe('-_-_');
  });

  it('drops padding only when omitPadding is truthy', () => {
    expect(encode(text('f'), { omitPadding: true })).toBe('Zg');
    expect(encode(text('fo'), { omitPadding: 1 })).toBe('Zm8');
    expect(encode(text('fo'), { omitPadding: 0 })).toBe('Zm8=');
  });

  it('encodes only the bytes in view of a subarray', () => {
    expect(encode(text('xfoox').subarray(1, 4))).toBe('Zm9v');
  });

  it('encodes inputs larger than one string chunk', () => {
    const input = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff);
    expect(encode(input)).toBe(Buffer.from(input).toString('base64'));
  });

  it('throws TypeError for a receiver that is not a Uint8Array', () => {
    expect(() => encode(new Uint8ClampedArray(1))).toThrow(TypeError);
    expect(() => encode([1, 2])).toThrow(TypeError);
    expect(() => encode({ [Symbol.toStringTag]: 'Uint8Array' })).toThrow(TypeError);
  });

  it('reads alphabet before omitPadding, and accepts a function as options', () => {
    const reads: string[] = [];
    encode(bytes(1), recordReads(reads));
    expect(reads).toEqual(['alphabet', 'omitPadding']);
    const options = Object.assign(() => {}, { omitPadding: true });
    expect(encode(text('f'), options)).toBe('Zg');
  });

  itDetaches('throws TypeError for a buffer detached before or by an option getter', () => {
    const array = bytes(1);
    detach(array);
    expect(() => encode(array)).toThrow(TypeError);
    const other = bytes(1);
    const options = {
      get omitPadding() {
        detach(other);
        return false;
      },
    };
    expect(() => encode(other, options)).toThrow(TypeError);
  });

  it('throws TypeError for invalid options', () => {
    expect(() => encode(bytes(1), null)).toThrow(TypeError);
    expect(() => encode(bytes(1), 'base64url')).toThrow(TypeError);
    expect(() => encode(bytes(1), { alphabet: 'Base64' })).toThrow(TypeError);
  });
});

describe('fromBase64', () => {
  it('decodes padded and unpadded input in the default loose mode', () => {
    expect(decode('Zm9vYmFy')).toEqual(text('foobar'));
    expect(decode('Zm8=')).toEqual(text('fo'));
    expect(decode('Zm8')).toEqual(text('fo'));
    expect(decode('Zg')).toEqual(text('f'));
    expect(decode('')).toEqual(bytes());
  });

  it('returns an array whose buffer has exactly the decoded length', () => {
    expect(decode('Zg==').buffer.byteLength).toBe(1);
  });

  it('skips ASCII whitespace anywhere, including between the padding characters', () => {
    expect(decode(' Zm\t9v\nYm\fFy\r ')).toEqual(text('foobar'));
    expect(decode('Zg= =')).toEqual(text('f'));
    // Only TAB, LF, FF, CR and SPACE are whitespace for this API.
    expect(() => decode('Zm9v\u000b')).toThrow(SyntaxError);
    expect(() => decode('Zm9v ')).toThrow(SyntaxError);
  });

  it('accepts only the characters of the selected alphabet', () => {
    expect(decode('-_-_', { alphabet: 'base64url' })).toEqual(bytes(0xfb, 0xff, 0xbf));
    expect(() => decode('-_-_')).toThrow(SyntaxError);
    expect(() => decode('+/+/', { alphabet: 'base64url' })).toThrow(SyntaxError);
  });

  it('throws SyntaxError for characters outside the alphabet, including non-ASCII', () => {
    expect(() => decode('Zm9v*')).toThrow(SyntaxError);
    expect(() => decode('Zm9vé')).toThrow(SyntaxError);
    expect(() => decode('Zm9v\ud800')).toThrow(SyntaxError);
  });

  it('throws SyntaxError for misplaced padding', () => {
    expect(() => decode('=')).toThrow(SyntaxError);
    expect(() => decode('Z=')).toThrow(SyntaxError);
    expect(() => decode('Zg=')).toThrow(SyntaxError);
    expect(() => decode('Zg=a')).toThrow(SyntaxError);
    expect(() => decode('Zg===')).toThrow(SyntaxError);
    expect(() => decode('Zm8=Zm8=')).toThrow(SyntaxError);
  });

  it('throws SyntaxError for a final chunk of one character in every mode', () => {
    expect(() => decode('Zm9vY')).toThrow(SyntaxError);
    expect(() => decode('Zm9vY', { lastChunkHandling: 'strict' })).toThrow(SyntaxError);
    expect(decode('Zm9vY', { lastChunkHandling: 'stop-before-partial' })).toEqual(text('foo'));
  });

  it('ignores non-zero extra bits in loose mode and rejects them in strict mode', () => {
    expect(decode('Zh==')).toEqual(text('f'));
    expect(decode('Zm9=')).toEqual(text('fo'));
    expect(() => decode('Zh==', { lastChunkHandling: 'strict' })).toThrow(SyntaxError);
    expect(() => decode('Zm9=', { lastChunkHandling: 'strict' })).toThrow(SyntaxError);
    expect(decode('Zg==', { lastChunkHandling: 'strict' })).toEqual(text('f'));
  });

  it('requires padding in strict mode', () => {
    expect(() => decode('Zm8', { lastChunkHandling: 'strict' })).toThrow(SyntaxError);
    expect(decode('Zm8=', { lastChunkHandling: 'strict' })).toEqual(text('fo'));
  });

  it('drops an unpadded final chunk in stop-before-partial mode, but decodes a padded one', () => {
    expect(decode('Zm9vZm8', { lastChunkHandling: 'stop-before-partial' })).toEqual(text('foo'));
    expect(decode('Zm9vZg=', { lastChunkHandling: 'stop-before-partial' })).toEqual(text('foo'));
    expect(decode('Zm9vZm8=', { lastChunkHandling: 'stop-before-partial' })).toEqual(text('foofo'));
  });

  it('throws TypeError for non-string input before reading options', () => {
    const options = {
      get alphabet() {
        throw new Error('options must not be read');
      },
    };
    expect(() => decode(123, options)).toThrow(TypeError);
    expect(() => decode(undefined)).toThrow(TypeError);
    expect(() => decode(new String('Zg=='))).toThrow(TypeError);
  });

  it('reads alphabet before lastChunkHandling, and accepts a function as options', () => {
    const reads: string[] = [];
    decode('Zg==', recordReads(reads));
    expect(reads).toEqual(['alphabet', 'lastChunkHandling']);
    const options = Object.assign(() => {}, { alphabet: 'base64url' });
    expect(decode('-_-_', options)).toEqual(bytes(0xfb, 0xff, 0xbf));
  });

  it('throws TypeError for invalid options', () => {
    expect(() => decode('Zg==', null)).toThrow(TypeError);
    expect(() => decode('Zg==', { alphabet: 'hex' })).toThrow(TypeError);
    expect(() => decode('Zg==', { lastChunkHandling: 'Strict' })).toThrow(TypeError);
  });

  it('round-trips random bytes of every length mod 3 in both alphabets', () => {
    for (const length of [1, 2, 3, 1000, 1001, 1002]) {
      const input = new Uint8Array(length).map((_, i) => (i * 7919) & 0xff);
      for (const alphabet of ['base64', 'base64url']) {
        for (const omitPadding of [false, true]) {
          expect(decode(encode(input, { alphabet, omitPadding }), { alphabet })).toEqual(input);
        }
      }
    }
  });
});

describe('setFromBase64', () => {
  it('returns how many characters it read and bytes it wrote', () => {
    const target = new Uint8Array(8);
    expect(setBase64(target, 'Zm9vYmFy')).toEqual({ read: 8, written: 6 });
    expect(target).toEqual(bytes(...text('foobar'), 0, 0));
  });

  it('counts trailing whitespace as read after decoding the whole string', () => {
    expect(setBase64(new Uint8Array(8), 'Zm9v  ')).toEqual({
      read: 6,
      written: 3,
    });
  });

  it('stops at the last whole chunk that fits into a short target', () => {
    const target = new Uint8Array(4);
    expect(setBase64(target, 'Zm9vYmFy')).toEqual({ read: 4, written: 3 });
    expect(target).toEqual(bytes(...text('foo'), 0));
    // A final chunk fits when its bytes fit, even if its padding has not been read.
    expect(setBase64(new Uint8Array(1), 'Zg')).toEqual({ read: 2, written: 1 });
    expect(setBase64(new Uint8Array(1), 'Zg==')).toEqual({
      read: 4,
      written: 1,
    });
    expect(setBase64(new Uint8Array(1), 'Zm9v')).toEqual({
      read: 0,
      written: 0,
    });
    expect(setBase64(new Uint8Array(2), 'Zm9v')).toEqual({
      read: 0,
      written: 0,
    });
    expect(setBase64(new Uint8Array(3), 'Zm9v Zm9v')).toEqual({
      read: 4,
      written: 3,
    });
  });

  it('does not validate input after the chunk that fills the target', () => {
    expect(setBase64(new Uint8Array(3), 'Zm9v***')).toEqual({ read: 4, written: 3 });
  });

  it('does not validate input when the target is empty', () => {
    expect(setBase64(new Uint8Array(0), '***')).toEqual({
      read: 0,
      written: 0,
    });
  });

  it('reports the end of the last whole chunk in stop-before-partial mode', () => {
    expect(
      setBase64(new Uint8Array(8), 'Zm9v Zm', {
        lastChunkHandling: 'stop-before-partial',
      })
    ).toEqual({ read: 4, written: 3 });
  });

  it('keeps the bytes decoded before an error', () => {
    const target = new Uint8Array(6);
    expect(() => setBase64(target, 'Zm9vYmF*')).toThrow(SyntaxError);
    expect(target).toEqual(bytes(...text('foo'), 0, 0, 0));
  });

  it('writes from the start of a subarray', () => {
    const backing = new Uint8Array(5);
    expect(setBase64(backing.subarray(1, 4), 'Zm9v')).toEqual({
      read: 4,
      written: 3,
    });
    expect(backing).toEqual(bytes(0, ...text('foo'), 0));
  });

  it('validates the receiver before the input', () => {
    expect(() => setBase64(new Uint16Array(4) as unknown as Uint8Array, 123)).toThrow('Uint8Array');
  });

  it('applies the alphabet and lastChunkHandling options', () => {
    const options = { alphabet: 'base64url' };
    expect(setBase64(new Uint8Array(3), '-_-_', options)).toEqual({ read: 4, written: 3 });
    expect(() => setBase64(new Uint8Array(3), '+/+/', options)).toThrow(SyntaxError);
    const strict = { lastChunkHandling: 'strict' };
    expect(() => setBase64(new Uint8Array(3), 'Zm8', strict)).toThrow(SyntaxError);
    expect(() => setBase64(new Uint8Array(3), 'Zh==', strict)).toThrow(SyntaxError);
    expect(setBase64(new Uint8Array(3), 'Zm8=', strict)).toEqual({ read: 4, written: 2 });
  });

  it('throws TypeError for non-string input and invalid options', () => {
    expect(() => setBase64(new Uint8Array(3), 123)).toThrow(TypeError);
    expect(() => setBase64(new Uint8Array(3), 'Zg==', { alphabet: 'hex' })).toThrow(TypeError);
    const options = { lastChunkHandling: 'Strict' };
    expect(() => setBase64(new Uint8Array(3), 'Zg==', options)).toThrow(TypeError);
  });

  it('reads alphabet before lastChunkHandling, and accepts a function as options', () => {
    const reads: string[] = [];
    setBase64(new Uint8Array(3), 'Zg==', recordReads(reads));
    expect(reads).toEqual(['alphabet', 'lastChunkHandling']);
    const options = Object.assign(() => {}, { alphabet: 'base64url' });
    expect(setBase64(new Uint8Array(3), '-_-_', options)).toEqual({ read: 4, written: 3 });
  });

  itDetaches('throws TypeError for a buffer detached before or by an option getter', () => {
    const array = new Uint8Array(3);
    detach(array);
    expect(() => setBase64(array, 'Zm9v')).toThrow(TypeError);
    const other = new Uint8Array(3);
    const options = {
      get lastChunkHandling() {
        detach(other);
        return 'loose';
      },
    };
    expect(() => setBase64(other, 'Zm9v', options)).toThrow(TypeError);
  });
});

describe('toHex', () => {
  it('encodes every byte as two lowercase hex digits', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(toHex.call(all)).toBe(Buffer.from(all).toString('hex'));
    expect(toHex.call(bytes())).toBe('');
  });

  it('encodes only the bytes in view of a subarray', () => {
    expect(toHex.call(bytes(0x00, 0xab, 0xcd, 0xff).subarray(1, 3))).toBe('abcd');
  });

  it('throws TypeError for a receiver that is not a Uint8Array', () => {
    expect(() => toHex.call(new Int8Array(1))).toThrow(TypeError);
  });

  itDetaches('throws TypeError for a detached buffer', () => {
    const array = bytes(1);
    detach(array);
    expect(() => toHex.call(array)).toThrow(TypeError);
  });
});

describe('fromHex', () => {
  it('decodes upper and lower case digits', () => {
    expect(fromHex('00ffAbcD')).toEqual(bytes(0x00, 0xff, 0xab, 0xcd));
    expect(fromHex('')).toEqual(bytes());
  });

  it('throws SyntaxError for an odd length', () => {
    expect(() => fromHex('abc')).toThrow(SyntaxError);
  });

  it('throws SyntaxError for non-hex characters, prefixes and whitespace', () => {
    expect(() => fromHex('0x12')).toThrow(SyntaxError);
    expect(() => fromHex('zz')).toThrow(SyntaxError);
    expect(() => fromHex('ab ')).toThrow(SyntaxError);
    expect(() => fromHex('éé')).toThrow(SyntaxError);
  });

  it('throws TypeError for non-string input', () => {
    expect(() => (fromHex as (value: unknown) => Uint8Array)(12)).toThrow(TypeError);
  });
});

describe('setFromHex', () => {
  it('stops when the target is full without validating the rest', () => {
    const target = new Uint8Array(1);
    expect(setHex(target, 'abzz')).toEqual({ read: 2, written: 1 });
    expect(target).toEqual(bytes(0xab));
  });

  it('rejects an odd length even when nothing would be written', () => {
    expect(() => setHex(new Uint8Array(0), 'abc')).toThrow(SyntaxError);
  });

  it('keeps the bytes decoded before an error', () => {
    const target = new Uint8Array(3);
    expect(() => setHex(target, 'abcdzz')).toThrow(SyntaxError);
    expect(target).toEqual(bytes(0xab, 0xcd, 0));
  });

  it('writes from the start of a subarray', () => {
    const backing = new Uint8Array(4);
    expect(setHex(backing.subarray(1, 3), 'abcd')).toEqual({ read: 4, written: 2 });
    expect(backing).toEqual(bytes(0, 0xab, 0xcd, 0));
  });

  it('throws TypeError for a receiver that is not a Uint8Array or for non-string input', () => {
    expect(() => setHex(new Uint16Array(2), 'abcd')).toThrow(TypeError);
    expect(() => setHex([0, 0], 'abcd')).toThrow(TypeError);
    expect(() => setHex(new Uint8Array(2), 0xabcd)).toThrow(TypeError);
  });

  itDetaches('throws TypeError for a detached buffer', () => {
    const array = new Uint8Array(2);
    detach(array);
    expect(() => setHex(array, 'abcd')).toThrow(TypeError);
  });
});

describe('installUint8ArrayBase64', () => {
  const names = {
    static: ['fromBase64', 'fromHex'],
    prototype: ['toBase64', 'toHex', 'setFromBase64', 'setFromHex'],
  } as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    for (const name of names.static) {
      saved.set(`static.${name}`, Object.getOwnPropertyDescriptor(Uint8Array, name));
    }
    for (const name of names.prototype) {
      saved.set(`prototype.${name}`, Object.getOwnPropertyDescriptor(Uint8Array.prototype, name));
    }
  });

  afterEach(() => {
    for (const [key, descriptor] of saved) {
      const [kind, name] = key.split('.') as [string, string];
      const target = kind === 'static' ? Uint8Array : Uint8Array.prototype;
      if (descriptor) {
        Object.defineProperty(target, name, descriptor);
      } else {
        delete (target as any)[name];
      }
    }
  });

  it('defines non-enumerable methods like the built-in ones', () => {
    installUint8ArrayBase64();
    for (const name of names.static) {
      expect(Object.getOwnPropertyDescriptor(Uint8Array, name)).toMatchObject({
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    for (const name of names.prototype) {
      expect(Object.getOwnPropertyDescriptor(Uint8Array.prototype, name)).toMatchObject({
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    expect(Uint8Array.fromBase64('aGk=').toHex()).toBe('6869');
  });

  it('gives every method the spec name and length, which minification would otherwise change', () => {
    installUint8ArrayBase64();
    const expected = [
      [Uint8Array, { fromBase64: 1, fromHex: 1 }],
      [Uint8Array.prototype, { toBase64: 0, toHex: 0, setFromBase64: 1, setFromHex: 1 }],
    ] as const;
    for (const [target, lengths] of expected) {
      for (const [name, length] of Object.entries(lengths)) {
        const method = (target as any)[name];
        expect({ name: method.name, length: method.length }).toEqual({ name, length });
      }
    }
  });

  it('keeps a method the engine already has and installs the missing ones', () => {
    const native = () => new Uint8Array(0);
    Object.defineProperty(Uint8Array, 'fromBase64', { value: native, configurable: true });
    installUint8ArrayBase64();
    expect(Uint8Array.fromBase64).toBe(native);
    expect(Uint8Array.prototype.toHex.call(bytes(0xab))).toBe('ab');
  });
});
