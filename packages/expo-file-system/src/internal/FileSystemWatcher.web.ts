import { UnavailabilityError } from 'expo-modules-core';

import type { Directory } from '../Directory';
import type { File } from '../File';
import type { WatchEvent, WatchOptions, WatchSubscription } from '../FileSystemWatcher.types';

type TargetFactory<T> = (uri: string, isDirectory: boolean) => T;

export class FileSystemWatcher<T extends File | Directory> implements WatchSubscription {
  constructor(
    _path: string,
    _callback: (event: WatchEvent<T>) => void,
    _options: WatchOptions = {},
    _targetFactory: TargetFactory<T>
  ) {
    const error = new UnavailabilityError('expo-file-system', 'watch');
    error.message =
      'watch is not available on web. Files on web are not stored on disk, so they cannot change.';
    throw error;
  }

  remove(): void {}
}
