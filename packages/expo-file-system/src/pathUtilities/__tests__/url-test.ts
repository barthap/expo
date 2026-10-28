import { PathUtilities } from '../index';

// The URL standard drops `localhost` from `file:` URLs, so Node's `URL` does too, but Chrome keeps
// it. This `URL` keeps the host like Chrome, so the test fails if `asUrl` stops dropping it.
class ChromeLikeUrl {
  protocol = 'file:';
  hostname: string;
  pathname: string;
  hash = '';

  constructor(url: string | ChromeLikeUrl) {
    const match = /^file:\/\/([^/]*)(\/.*)$/.exec(String(url));
    if (!match) {
      throw new TypeError('Invalid URL');
    }
    this.hostname = match[1]!;
    this.pathname = match[2]!;
  }

  toString() {
    return `file://${this.hostname}${this.pathname}`;
  }
}

describe('file: URLs with a localhost host', () => {
  const originalUrl = globalThis.URL;

  beforeEach(() => {
    globalThis.URL = ChromeLikeUrl as unknown as typeof URL;
  });

  afterEach(() => {
    globalThis.URL = originalUrl;
  });

  it('`Paths.join` drops the host', () => {
    expect(PathUtilities.join('file://localhost/a')).toBe('file:///a');
  });
});
