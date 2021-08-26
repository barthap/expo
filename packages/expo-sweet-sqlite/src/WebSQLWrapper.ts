// @needsAudit @docsMissing

import { ResultSet, SQLError, SQLTransaction, WebSQLDatabase } from './SQLite.types';
import { ExpoSQLiteDatabase } from './SQLiteDatabase';

type Rows = ResultSet['rows'];

class WebSQLRows {
  _array: Rows;
  length: number;
  constructor(array: Rows) {
    this._array = array;
    this.length = array.length;
  }

  item(i) {
    return this._array[i];
  }
}

class WebSQLResultSet {
  insertId: number | undefined;
  rowsAffected: number;
  rows: WebSQLRows;
  constructor(insertId: number | undefined, rowsAffected: number, rows: Rows) {
    this.insertId = insertId;
    this.rowsAffected = rowsAffected;
    this.rows = new WebSQLRows(rows);
  }
}

// WebSQL has some bizarre behavior regarding insertId/rowsAffected. To try
// to match the observed behavior of Chrome/Safari as much as possible, we
// sniff the SQL message to try to massage the returned insertId/rowsAffected.
// This helps us pass the tests, although it's error-prone and should
// probably be revised.
function massageSQLResult(sql: string, { insertId, rowsAffected, rows }: ResultSet) {
  if (/^\s*UPDATE\b/i.test(sql)) {
    // insertId is always undefined for "UPDATE" statements
    insertId = void 0;
  } else if (/^\s*CREATE\s+TABLE\b/i.test(sql)) {
    // WebSQL always returns an insertId of 0 for "CREATE TABLE" statements
    insertId = 0;
    rowsAffected = 0;
  } else if (/^\s*DROP\s+TABLE\b/i.test(sql)) {
    // WebSQL always returns insertId=undefined and rowsAffected=0
    // for "DROP TABLE" statements. Go figure.
    insertId = void 0;
    rowsAffected = 0;
  } else if (!/^\s*INSERT\b/i.test(sql)) {
    // for all non-inserts (deletes, etc.) insertId is always undefined
    // ¯\_(ツ)_/¯
    insertId = void 0;
  }
  return new WebSQLResultSet(insertId, rowsAffected, rows);
}

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
  const db = ExpoSQLiteDatabase.open(name);

  const webSqlDb: WebSQLDatabase = {
    version,
    exec(queries, _readOnly, callback) {
      db.rawExecuteSql(queries).then(
        result => {
          callback(null, result);
        },
        error => {
          callback(error);
        }
      );
    },
    transaction(callback, onError, onSuccess) {
      db.transaction(async tx => {
        callback({
          executeSql(sql, args, successCallback, errorCallback) {
            tx.executeSql({ sql, args: args ?? [] }).then(
              result => {
                if ('error' in result) {
                  errorCallback?.(this, result.error as SQLError);
                } else {
                  successCallback?.(this, massageSQLResult(sql, result));
                }
              },
              err => {
                errorCallback?.(this, err);
              }
            );
          },
        });
      }).then(onSuccess, onError);
    },
    readTransaction(callback, _onError, onSuccess) {
      callback({
        executeSql(sql, args, callback, errorCallback) {
          db.executeSql({ sql, args: args ?? [] }).then(
            result => {
              if ('error' in result) {
                errorCallback?.(this, result.error);
              } else {
                callback?.(this, massageSQLResult(sql, result));
              }
            },
            error => {
              errorCallback?.(this, error);
            }
          );
        },
      });
      onSuccess?.();
    },
  };

  callback?.(webSqlDb);
  return webSqlDb;
}
