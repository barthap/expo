import diff from 'jest-diff';

import { Query, QueryResult } from '../SQLite.types';
import { ExpoSQLiteDatabase } from '../SQLiteDatabase';

interface MockedExpoSQLiteDatabase extends jest.Mocked<ExpoSQLiteDatabase> {
  getCallHistory(): Query[];
  resetCallHistory();
  failWhenSqlMatches(regex: RegExp, error?: Error);
  failOnNthStatement(n: number, error?: Error);
}

export const MockExpoSQLiteDatabase = (name: string = 'testDb'): MockedExpoSQLiteDatabase => {
  const sqlCalls: Query[] = [];
  const mockIdxResults: { [key: number]: QueryResult | undefined } = {};
  const mockRegexResults: { regex: RegExp; result: QueryResult }[] = [];

  const mockExecuteSqlImpl = (query: Query) => {
    sqlCalls.push(query);

    const mockResult: QueryResult | undefined = mockIdxResults[sqlCalls.length - 1];
    if (mockResult != null) {
      if ('error' in mockResult) {
        return Promise.reject(mockResult.error);
      } else {
        return Promise.resolve(mockResult);
      }
    }

    for (const regexMock of mockRegexResults) {
      if (!regexMock.regex.test(query.sql)) continue;

      if ('error' in regexMock.result) {
        return Promise.reject(regexMock.result.error);
      } else {
        return Promise.resolve(regexMock.result);
      }
    }

    return Promise.resolve({ rowsAffected: 0, rows: [] });
  };

  return ({
    name,
    close: jest.fn(),
    select: jest.fn().mockImplementation(mockExecuteSqlImpl),
    insert: jest.fn().mockImplementation(mockExecuteSqlImpl),
    updateDelete: jest.fn().mockImplementation(mockExecuteSqlImpl),
    transaction: jest.fn(),
    executeSql: jest.fn().mockImplementation(mockExecuteSqlImpl),
    getCallHistory: () => sqlCalls,
    resetCallHistory: () => {
      sqlCalls.splice(0, sqlCalls.length);
    },
    failWhenSqlMatches(regex: RegExp, error?: Error) {
      mockRegexResults.push({
        regex,
        result: { error: error ?? new Error(`Mock Failure on ${regex}`) },
      });
    },
    failOnNthStatement(n: number, error?: Error) {
      if (n < 1) {
        throw new Error(`Cannot mock`);
      }
      mockIdxResults[n - 1] = { error: error ?? new Error(`Mock Failure on ${n}-th statement`) };
    },
  } as unknown) as MockedExpoSQLiteDatabase;
};

// Custom Jest Matchers for the above mock

// TS declarations
declare global {
  namespace jest {
    interface Matchers<R> {
      /**
       * Check if SQL matching `sqlRegex` was executed by the db
       */
      didExecuteSqlMatching(sqlRegex: RegExp, options?: { times?: number }): R;
      /**
       * Check if `n`-th (1-based) statement was matching provided regex
       */
      nthExecutedSqlMatching(n: number, sqlRegex: RegExp): R;
    }
  }
}

expect.extend({
  didExecuteSqlMatching(received: any, expected: RegExp, { times }: { times?: number } = {}) {
    if (!isReceiverAMockedDatabase(received)) {
      return notAMockedDatabaseFailure;
    }

    const callHistory = received.getCallHistory();
    const count = callHistory.filter(call => expected.test(call.sql)).length;

    if (times == null) {
      return {
        pass: count > 0,
        message: () => `Expected statement: ${expected} was not executed by the database.`,
      };
    } else {
      return {
        pass: count === times,
        message: () =>
          `Statement: ${expected} was executed ${count} times, but expected ${times} to be ran times.`,
      };
    }
  },
  nthExecutedSqlMatching(received: any, n: number, expected: RegExp) {
    if (!isReceiverAMockedDatabase(received)) {
      return notAMockedDatabaseFailure;
    }

    const callHistory = received.getCallHistory();

    // n is 1-based
    if (callHistory.length < n) {
      return {
        pass: false,
        message: () =>
          `${n}-th sql was expected to be ${expected}, but there was only ${callHistory.length} statements executed by the database`,
      };
    }

    const stmt = callHistory[n - 1].sql;
    return {
      pass: expected.test(stmt),
      message: () =>
        `${n}-th executed SQL statement was different than expected:\n${diff(
          expected.toString(),
          stmt
        )}`,
    };
  },
});

// helpers
const notAMockedDatabaseFailure = {
  pass: false,
  message: () => 'Provided object is not a mocked ExpoSQLiteDatabase',
};

function isReceiverAMockedDatabase(receiver: any): receiver is MockedExpoSQLiteDatabase {
  return 'getCallHistory' in receiver && typeof receiver.getCallHistory === 'function';
}
