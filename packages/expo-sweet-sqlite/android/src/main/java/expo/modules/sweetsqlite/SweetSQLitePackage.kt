package expo.modules.sweetsqlite

import android.content.Context
import expo.modules.core.BasePackage

class SweetSQLitePackage : BasePackage() {
  override fun createExportedModules(context: Context) = listOf(SweetSQLiteModule(context))
}
