import { NativeModulesProxy, ProxyNativeModule } from "expo-modules-core";

import { QueryResult } from "./SQLite.types";
import { StatementType } from "./SQLiteStatementUtils";

const { SweetSQLite } = NativeModulesProxy;

export type NativeQueryParam = [sql: string, args: unknown[], type?: StatementType];
export type NativeQueryResult = [errorMessage: string | null, insertId: number | undefined, rowsAffected: number, columns: string[], rows: any[]];

interface NativeSQLiteModule extends ProxyNativeModule {
  exec(dbName: string, queries: NativeQueryParam[], readOnly: boolean): Promise<NativeQueryResult[]>;
  close(dbName: string): Promise<void>;
}

export default SweetSQLite as NativeSQLiteModule;
