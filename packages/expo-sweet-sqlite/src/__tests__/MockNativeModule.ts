import diff from 'jest-diff';

import { NativeQueryParam, NativeQueryResult } from '../ExpoSQLite';
import { QueryResult } from '../SQLite.types';

const sqlCalls: NativeQueryParam[] = [];
const mockIdxResults: { [key: number]: QueryResult | undefined } = {};
const mockRegexResults: { regex: RegExp; result: QueryResult }[] = [];

const serializeExpectedToNativeResult = (result: QueryResult): NativeQueryResult => {
  if ('error' in result) {
    return [result.error.message, 0, 0, [], []];
  }

  return [
    null,
    result.insertId,
    result.rowsAffected,
    Object.keys(result.rows),
    Object.values(result.rows),
  ];
};

const mockExecuteSqlImpl = (query: NativeQueryParam) => {
  sqlCalls.push(query);

  const mockResult: QueryResult | undefined = mockIdxResults[sqlCalls.length - 1];
  if (mockResult != null) {
    return serializeExpectedToNativeResult(mockResult);
  }

  for (const regexMock of mockRegexResults) {
    if (regexMock.regex.test(query[0])) {
      return serializeExpectedToNativeResult(regexMock.result);
    }
  }

  return serializeExpectedToNativeResult({ rowsAffected: 0, rows: [] });
};

export const getSqlHistory = () => sqlCalls;

export const resetSqlHistory = () => {
  sqlCalls.splice(0, sqlCalls.length);
};

export const mockNativeSQLite = () => ({
  exec: jest
    .fn()
    .mockImplementation((_dbName: string, queries: NativeQueryParam[], _readOnly: boolean) => {
      return Promise.resolve(queries.map(mockExecuteSqlImpl));
    }),
  close: jest.fn(),
});
// Custom Jest Matchers for the above mock

// TS declarations
declare global {
  namespace jest {
    interface Matchers<R> {
      /**
       * Check if SQL matching `sqlRegex` was executed by the db
       */
      didNativelyExecuteSqlMatching(sqlRegex: RegExp, options?: { times?: number }): R;
      executedExactlyFollowingSql(expected: (string | RegExp)[]): R;
    }
  }
}

expect.extend({
  didNativelyExecuteSqlMatching(
    callHistory: NativeQueryParam[],
    expected: RegExp,
    { times }: { times?: number } = {}
  ) {
    const count = callHistory.filter(call => expected.test(call[0])).length;

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

  executedExactlyFollowingSql(callHistory: NativeQueryParam[], expected: (string | RegExp)[]) {
    if (callHistory.length !== expected.length) {
      return {
        pass: false,
        message: () =>
          `Expected ${expected.length} SQL statements, but ${callHistory.length} were executed`,
      };
    }

    const differences = callHistory
      .map(param => param[0])
      .map((sql, index) => {
        const expect = expected[index];
        if (sql.match(expect) != null) {
          return null;
        }

        const expectedStr = typeof expect === 'string' ? expect : `Regex: ${expect.toString()}`;
        return diff(expectedStr, sql);
      })
      .filter(it => it != null);

    return {
      pass: differences.length === 0,
      message: () =>
        `The SQL statements executed didn't match expected:\n${differences.join('\n')}`,
    };
  },
});
