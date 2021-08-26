import { Platform } from 'expo-modules-core';
import zipObject from 'lodash/zipObject';
import Queue from 'tiny-queue';

import SweetSQLite, { NativeQueryParam, NativeQueryResult } from './ExpoSQLite';
import {
  ExpoSQLiteTransactionBlock,
  InsertResult,
  Query,
  QueryResult,
  ResultSetError,
  SelectResult,
  SQLInterface,
  UpdateResult,
} from './SQLite.types';
import { escapeBlob, getSqlStatementType, StatementType } from './SQLiteStatementUtils';
import { ExpoSQLiteTransactionQueue } from './SQLiteTransactions';

/**
 * Represents a single SQL statement task. Used by for queueing SQL statements.
 */
interface SQLTask {
  query: Query;
  resolver: (result: QueryResult) => void;
  rejecter: (err?: unknown) => void;
}

/**
 * Main class for Expo SQLite Module
 */
export class ExpoSQLiteDatabase implements SQLInterface {
  private constructor(private name: string) {}

  /**
   * Opens a database with specified name. Creates database if it doesn't exist yet
   * @param name A database name
   * @returns An {@link ExpoSQLiteDatabase} instance
   */
  static open(name: string): ExpoSQLiteDatabase {
    return new ExpoSQLiteDatabase(name);
  }

  private isOpen = true;
  private isSqlExecuting = false;
  private sqlQueue = new Queue<SQLTask>();
  private txnQueue = new ExpoSQLiteTransactionQueue(this);

  async close() {
    this.isOpen = false;
    await SweetSQLite.close(this.name);
  }

  async transaction(transactionBlock: ExpoSQLiteTransactionBlock) {
    return await this.txnQueue.startTransaction(transactionBlock);
  }

  async executeSql(sql: string): Promise<QueryResult>;
  async executeSql(query: Query): Promise<QueryResult>;
  async executeSql(query: Query | string): Promise<QueryResult> {
    if (typeof query === 'string') {
      query = { sql: query, args: [] };
    }
    return new Promise((resolver, rejecter) => {
      this.sqlQueue.push({ query: query as Query, resolver, rejecter });
      this.runSqlBatch();
    });
  }

  // convenience methods
  async select(query: string, args: any[] = []): Promise<SelectResult> {
    if (getSqlStatementType(query) !== StatementType.SELECT) {
      throw new Error('Statement is not SELECT');
    }
    return await this.executeSql({ sql: query, args });
  }
  async insert(sql: string, args: any[] = []): Promise<InsertResult> {
    if (getSqlStatementType(sql) !== StatementType.INSERT) {
      throw new Error('Statement is not INSERT');
    }
    return await this.executeSql({ sql, args });
  }
  async updateDelete(sql: string, args: any[] = []): Promise<UpdateResult> {
    const type = getSqlStatementType(sql);
    if (type !== StatementType.UPDATE && type !== StatementType.DELETE) {
      throw new Error('Statement is neither UPDATE or DELETE');
    }
    return await this.executeSql({ sql, args });
  }

  // low-level api
  async rawExecuteSql(queries: Query[]): Promise<QueryResult[]> {
    if (!this.isOpen) {
      throw new Error('Cannot exeute operations on closed database!');
    }

    const preparedQuery: NativeQueryParam[] = queries
      .map(query => ({
        ...query,
        type: getSqlStatementType(query.sql),
      }))
      .map(query => [
        query.sql,
        Platform.OS === 'android' ? query.args.map(escapeBlob) : query.args,
        query.type,
      ]);

    const nativeResults = await SweetSQLite.exec(this.name, preparedQuery, false);
    return nativeResults.map(this.deserializeNativeResult);
  }

  private deserializeNativeResult(nativeResult: NativeQueryResult): QueryResult {
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

  private async runSqlBatch() {
    if (this.isSqlExecuting || this.sqlQueue.length < 1) {
      return;
    }

    const sqlTasks: SQLTask[] = [];
    while (this.sqlQueue.length > 0) {
      sqlTasks.push(this.sqlQueue.shift() as SQLTask);
    }

    try {
      this.isSqlExecuting = true;
      const results = await this.rawExecuteSql(sqlTasks.map(task => task.query));
      results.forEach((result, index) => {
        if ('error' in result) {
          sqlTasks[index].rejecter(result);
        } else {
          sqlTasks[index].resolver(result);
        }
      });
    } catch (err) {
      // It catches if something crucial fails, e.g. native bridge
      // It doesn't catch if a single query fails

      // TODO: check if it may reject if some of them are already resolved!
      // for now reject all
      sqlTasks.forEach(task => task.rejecter(err));
    } finally {
      this.isSqlExecuting = false;
      this.runSqlBatch();
    }
  }
}
