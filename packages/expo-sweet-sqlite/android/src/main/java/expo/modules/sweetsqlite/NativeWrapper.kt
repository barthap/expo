package expo.modules.sweetsqlite

class NativeWrapper {

  companion object {
    @JvmStatic external fun nativeMultiply(a: Int, b: Int): Int
  }
}