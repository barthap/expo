import './polyfillNextTick';
import './ts-declarations/tiny-queue';

import customOpenDatabase from '@expo/websql/custom';
import zipObject from 'lodash/zipObject';
import { Platform } from 'react-native';

import SweetSQLite from './ExpoSQLite';
import { Query, SQLiteCallback, ResultSet, ResultSetError, WebSQLDatabase } from './SQLite.types';

class SQLiteDatabase {
  _name: string;
  _closed: boolean = false;

  constructor(name: string) {
    this._name = name;
  }

  exec(queries: Query[], readOnly: boolean, callback: SQLiteCallback): void {
    if (this._closed) {
      throw new Error(`The SQLite database is closed`);
    }

    SweetSQLite.exec(this._name, queries.map(_serializeQuery), readOnly).then(
      nativeResultSets => {
        callback(null, nativeResultSets.map(_deserializeResultSet));
      },
      error => {
        // TODO: make the native API consistently reject with an error, not a string or other type
        callback(error instanceof Error ? error : new Error(error));
      }
    );
  }

  close() {
    this._closed = true;
    SweetSQLite.close(this._name);
  }
}

function _serializeQuery(query: Query): [string, unknown[]] {
  return [query.sql, Platform.OS === 'android' ? query.args.map(_escapeBlob) : query.args];
}

function _deserializeResultSet(nativeResult): ResultSet | ResultSetError {
  const [errorMessage, insertId, rowsAffected, columns, rows] = nativeResult;
  // TODO: send more structured error information from the native module so we can better construct
  // a SQLException object
  if (errorMessage !== null) {
    return { error: new Error(errorMessage) } as ResultSetError;
  }

  return {
    insertId,
    rowsAffected,
    rows: rows.map(row => zipObject(columns, row)),
  };
}

function _escapeBlob<T>(data: T): T {
  if (typeof data === 'string') {
    /* eslint-disable no-control-regex */
    return data
      .replace(/\u0002/g, '\u0002\u0002')
      .replace(/\u0001/g, '\u0001\u0002')
      .replace(/\u0000/g, '\u0001\u0001') as any;
    /* eslint-enable no-control-regex */
  } else {
    return data;
  }
}

const _openExpoSQLiteDatabase = customOpenDatabase(SQLiteDatabase);

function addExecMethod(db: any): WebSQLDatabase {
  db.exec = (queries: Query[], readOnly: boolean, callback: SQLiteCallback): void => {
    db._db.exec(queries, readOnly, callback);
  };
  return db;
}

// @needsAudit @docsMissing
/**
 * Open a database, creating it if it doesn't exist, and return a `Database` object. On disk,
 * the database will be created under the app's [documents directory](../filesystem), i.e.
 * `${FileSystem.documentDirectory}/SQLite/${name}`.
 * > The `version`, `description` and `size` arguments are ignored, but are accepted by the function
 * for compatibility with the WebSQL specification.
 * @param name Name of the database file to open.
 * @param version
 * @param description
 * @param size
 * @param callback
 * @return
 */
export function openDatabase(
  name: string,
  version: string = '1.0',
  description: string = name,
  size: number = 1,
  callback?: (db: WebSQLDatabase) => void
): WebSQLDatabase {
  if (name === undefined) {
    throw new TypeError(`The database name must not be undefined`);
  }
  const db = _openExpoSQLiteDatabase(name, version, description, size, callback);
  const dbWithExec = addExecMethod(db);
  return dbWithExec;
}

/////////////////////////////////////////////////////////////////////////////////////

type QueryResult = ResultSet | ResultSetError;
type TransactionCallback = (tx: {
  executeSql: (query: string) => Promise<QueryResult>;
}) => Promise<void>;

export class SweetSQLiteDatabase {
  constructor(private name: string) {
    console.log(SweetSQLite);
  }

  version: string = '0.0';

  async transaction(callback: TransactionCallback): Promise<void> {
    try {
      console.log(this.name);
      await SweetSQLite.beginTransaction(this.name);

      await callback({ executeSql: this.executeSql.bind(this) });

      await SweetSQLite.setTransactionSuccessful(this.name);
    } catch (err) {
      console.error(err);
      throw new Error('Transaction failed');
    } finally {
      await SweetSQLite.finishTransaction(this.name);
    }
  }

  async executeSql(query: string): Promise<QueryResult> {
    const [result] = await SweetSQLite.exec(
      this.name,
      [_serializeQuery({ sql: query, args: [] })],
      false
    );
    return _deserializeResultSet(result);
  }
}

///////////////////////////////////////////////////////////////////////////////////
