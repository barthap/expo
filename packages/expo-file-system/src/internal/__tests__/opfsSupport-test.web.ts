/**
 * @jest-environment node
 */
// The Node environment has none of the OPFS globals, so each test defines the ones it needs.
import { detectOpfs } from '../opfsSupport';

const GLOBALS = ['isSecureContext', 'navigator', 'FileSystemFileHandle'] as const;
const originals = GLOBALS.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));

type Browser = {
  isSecureContext?: boolean;
  storage?: object;
  createWritable?: boolean;
};

function defineGlobal(name: (typeof GLOBALS)[number], value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// Defines the globals of a browser with OPFS, without the parts the options leave out.
function setUpBrowser({
  isSecureContext = true,
  storage = { getDirectory: async () => ({}) },
  createWritable = true,
}: Browser = {}) {
  defineGlobal('isSecureContext', isSecureContext);
  defineGlobal('navigator', { storage });
  class FileSystemFileHandle {}
  if (createWritable) {
    Object.assign(FileSystemFileHandle.prototype, { createWritable: async () => ({}) });
  }
  defineGlobal('FileSystemFileHandle', FileSystemFileHandle);
}

afterEach(() => {
  GLOBALS.forEach((name, index) => {
    const original = originals[index];
    if (original) {
      Object.defineProperty(globalThis, name, original);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  });
});

describe('detectOpfs', () => {
  it('is true when every OPFS part is there', () => {
    setUpBrowser();
    expect(detectOpfs()).toBe(true);
  });

  it('is false outside a browser, where none of the globals exist', () => {
    for (const name of GLOBALS) {
      delete (globalThis as Record<string, unknown>)[name];
    }
    expect(detectOpfs()).toBe(false);
  });

  // Browsers hide OPFS on pages served over plain `http:` from a host other than localhost.
  it('is false outside a secure context', () => {
    setUpBrowser({ isSecureContext: false });
    expect(detectOpfs()).toBe(false);
  });

  it('is false without `navigator.storage`', () => {
    setUpBrowser({ storage: undefined });
    defineGlobal('navigator', {});
    expect(detectOpfs()).toBe(false);
  });

  it('is false without `navigator.storage.getDirectory()`', () => {
    setUpBrowser({ storage: {} });
    expect(detectOpfs()).toBe(false);
  });

  it('is false without `FileSystemFileHandle`', () => {
    setUpBrowser();
    delete (globalThis as Record<string, unknown>).FileSystemFileHandle;
    expect(detectOpfs()).toBe(false);
  });

  // Safari had OPFS for years before `createWritable()`, which the storage needs to write files
  // from the main thread.
  it('is false without `FileSystemFileHandle.prototype.createWritable()`', () => {
    setUpBrowser({ createWritable: false });
    expect(detectOpfs()).toBe(false);
  });
});

describe('isOpfsAvailable', () => {
  function loadIsOpfsAvailable(): () => boolean {
    let isOpfsAvailable!: () => boolean;
    jest.isolateModules(() => {
      isOpfsAvailable = require('../opfsSupport').isOpfsAvailable;
    });
    return isOpfsAvailable;
  }

  it('checks the browser on the first call and keeps the answer', () => {
    setUpBrowser();
    const isOpfsAvailable = loadIsOpfsAvailable();
    expect(isOpfsAvailable()).toBe(true);
    defineGlobal('isSecureContext', false);
    expect(isOpfsAvailable()).toBe(true);
  });

  it('keeps a negative answer too', () => {
    setUpBrowser({ createWritable: false });
    const isOpfsAvailable = loadIsOpfsAvailable();
    expect(isOpfsAvailable()).toBe(false);
    setUpBrowser();
    expect(isOpfsAvailable()).toBe(false);
  });

  it('does not read the globals before the first call', () => {
    setUpBrowser({ isSecureContext: false });
    const isOpfsAvailable = loadIsOpfsAvailable();
    setUpBrowser();
    expect(isOpfsAvailable()).toBe(true);
  });
});
