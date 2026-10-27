package expo.modules.winter

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array

/**
 * Native fast paths for the `Uint8Array` base64 and hex methods that the winter runtime installs.
 * They handle only well-formed input with the default options. For anything else they return
 * `null`, and the JavaScript implementation runs instead and produces the spec's result or error.
 */
class Uint8ArrayBase64Module : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoUint8ArrayBase64")

    Function("decodeBase64") { string: String, url: Boolean ->
      decodeBase64(string, if (url) base64UrlValues else base64Values)
    }

    Function("decodeHex") { string: String ->
      decodeHex(string)
    }

    Function("encodeHex") { bytes: Uint8Array ->
      // A view of the typed array's bytes, so the input is not copied first.
      val input = bytes.toDirectBuffer()
      val output = ByteArray(bytes.length * 2)
      for (index in 0 until bytes.length) {
        val byte = input.get(index).toInt() and 0xff
        output[index * 2] = hexDigits[byte shr 4]
        output[index * 2 + 1] = hexDigits[byte and 0x0f]
      }
      String(output, Charsets.ISO_8859_1)
    }
  }
}

private val hexDigits = "0123456789abcdef".toByteArray(Charsets.US_ASCII)
private val base64Values = makeDecodeTable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
private val base64UrlValues = makeDecodeTable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
private val hexValues = makeDecodeTable("0123456789abcdef").also { table ->
  "ABCDEF".forEachIndexed { index, char -> table[char.code] = 10 + index }
}

private fun makeDecodeTable(alphabet: String): IntArray {
  val table = IntArray(256) { -1 }
  alphabet.forEachIndexed { index, char -> table[char.code] = index }
  return table
}

// Characters outside Latin-1 map to an index that no table accepts.
private fun valueOf(table: IntArray, char: Char): Int {
  val code = char.code
  return if (code < 256) table[code] else -1
}

/**
 * Decodes base64 with no whitespace, padding only at the end of a 4-character chunk, and zero
 * extra bits in the last chunk. Everything else returns `null`, including input the spec accepts.
 */
private fun decodeBase64(input: String, table: IntArray): ByteArray? {
  var length = input.length
  if (length % 4 == 1) {
    return null
  }
  if (length % 4 == 0 && length > 0 && input[length - 1] == '=') {
    length -= if (input[length - 2] == '=') 2 else 1
  }
  val fullChunks = length / 4
  val remainder = length % 4
  if (remainder == 1) {
    return null
  }
  val output = ByteArray(fullChunks * 3 + if (remainder == 0) 0 else remainder - 1)
  var read = 0
  var written = 0
  repeat(fullChunks) {
    val a = valueOf(table, input[read])
    val b = valueOf(table, input[read + 1])
    val c = valueOf(table, input[read + 2])
    val d = valueOf(table, input[read + 3])
    if ((a or b or c or d) < 0) {
      return null
    }
    val triple = (a shl 18) or (b shl 12) or (c shl 6) or d
    output[written] = (triple shr 16).toByte()
    output[written + 1] = (triple shr 8).toByte()
    output[written + 2] = triple.toByte()
    read += 4
    written += 3
  }
  if (remainder >= 2) {
    val a = valueOf(table, input[read])
    val b = valueOf(table, input[read + 1])
    val c = if (remainder == 3) valueOf(table, input[read + 2]) else 0
    if ((a or b or c) < 0) {
      return null
    }
    val triple = (a shl 18) or (b shl 12) or (c shl 6)
    // Non-zero extra bits are an error in strict mode and ignored in loose mode, so they are
    // left to the JavaScript implementation.
    if ((remainder == 2 && triple and 0xffff != 0) || (remainder == 3 && triple and 0xff != 0)) {
      return null
    }
    output[written] = (triple shr 16).toByte()
    if (remainder == 3) {
      output[written + 1] = (triple shr 8).toByte()
    }
  }
  return output
}

private fun decodeHex(input: String): ByteArray? {
  if (input.length % 2 != 0) {
    return null
  }
  val output = ByteArray(input.length / 2)
  for (index in output.indices) {
    val high = valueOf(hexValues, input[index * 2])
    val low = valueOf(hexValues, input[index * 2 + 1])
    if ((high or low) < 0) {
      return null
    }
    output[index] = ((high shl 4) or low).toByte()
  }
  return output
}
