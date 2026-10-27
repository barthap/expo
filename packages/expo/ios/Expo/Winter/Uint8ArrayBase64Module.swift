import ExpoModulesCore
import Foundation

/**
 Native fast paths for the `Uint8Array` base64 and hex methods that the winter runtime installs.
 They handle only well-formed input with the default options. For anything else they return `nil`,
 and the JavaScript implementation runs instead and produces the spec's result or error.
 */
public final class Uint8ArrayBase64Module: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoUint8ArrayBase64")

    Function("decodeBase64") { (string: String, url: Bool) -> Data? in
      var string = string
      return string.withUTF8 { input in
        decodeBase64(input, table: url ? base64UrlValues : base64Values)
      }
    }

    Function("decodeHex") { (string: String) -> Data? in
      var string = string
      return string.withUTF8 { input in
        decodeHex(input)
      }
    }

    Function("encodeHex") { (bytes: Uint8Array) -> String in
      let count = bytes.length
      if count == 0 {
        return ""
      }
      let input = UnsafeRawBufferPointer(start: bytes.rawPointer, count: count)
      return String(unsafeUninitializedCapacity: count * 2) { output in
        for (index, byte) in input.enumerated() {
          output[index * 2] = hexDigits[Int(byte >> 4)]
          output[index * 2 + 1] = hexDigits[Int(byte & 0x0f)]
        }
        return count * 2
      }
    }
  }
}

private let hexDigits: [UInt8] = Array("0123456789abcdef".utf8)
private let base64Values = makeDecodeTable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
private let base64UrlValues = makeDecodeTable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
private let hexValues: [Int8] = {
  var table = makeDecodeTable("0123456789abcdef")
  for (index, code) in "ABCDEF".utf8.enumerated() {
    table[Int(code)] = Int8(10 + index)
  }
  return table
}()

private func makeDecodeTable(_ alphabet: String) -> [Int8] {
  var table = [Int8](repeating: -1, count: 256)
  for (index, code) in alphabet.utf8.enumerated() {
    table[Int(code)] = Int8(index)
  }
  return table
}

/**
 Decodes base64 with no whitespace, padding only at the end of a 4-character chunk, and zero
 extra bits in the last chunk. Everything else returns `nil`, including input the spec accepts.
 */
private func decodeBase64(_ input: UnsafeBufferPointer<UInt8>, table: [Int8]) -> Data? {
  var length = input.count
  if length % 4 == 1 {
    return nil
  }
  if length % 4 == 0 && length > 0 && input[length - 1] == UInt8(ascii: "=") {
    length -= input[length - 2] == UInt8(ascii: "=") ? 2 : 1
  }
  let fullChunks = length / 4
  let remainder = length % 4
  if remainder == 1 {
    return nil
  }
  let outputLength = fullChunks * 3 + (remainder == 0 ? 0 : remainder - 1)
  var output = Data(count: outputLength)
  let isValid = table.withUnsafeBufferPointer { values in
    output.withUnsafeMutableBytes { (rawOutput: UnsafeMutableRawBufferPointer) -> Bool in
      let out = rawOutput.bindMemory(to: UInt8.self)
      var read = 0
      var written = 0
      for _ in 0..<fullChunks {
        let a = Int32(values[Int(input[read])])
        let b = Int32(values[Int(input[read + 1])])
        let c = Int32(values[Int(input[read + 2])])
        let d = Int32(values[Int(input[read + 3])])
        if (a | b | c | d) < 0 {
          return false
        }
        let triple = (a << 18) | (b << 12) | (c << 6) | d
        out[written] = UInt8(truncatingIfNeeded: triple >> 16)
        out[written + 1] = UInt8(truncatingIfNeeded: triple >> 8)
        out[written + 2] = UInt8(truncatingIfNeeded: triple)
        read += 4
        written += 3
      }
      if remainder >= 2 {
        let a = Int32(values[Int(input[read])])
        let b = Int32(values[Int(input[read + 1])])
        let c = remainder == 3 ? Int32(values[Int(input[read + 2])]) : 0
        if (a | b | c) < 0 {
          return false
        }
        let triple = (a << 18) | (b << 12) | (c << 6)
        // Non-zero extra bits are an error in strict mode and ignored in loose mode, so they are
        // left to the JavaScript implementation.
        if (remainder == 2 && triple & 0xffff != 0) || (remainder == 3 && triple & 0xff != 0) {
          return false
        }
        out[written] = UInt8(truncatingIfNeeded: triple >> 16)
        if remainder == 3 {
          out[written + 1] = UInt8(truncatingIfNeeded: triple >> 8)
        }
      }
      return true
    }
  }
  return isValid ? output : nil
}

private func decodeHex(_ input: UnsafeBufferPointer<UInt8>) -> Data? {
  if input.count % 2 != 0 {
    return nil
  }
  var output = Data(count: input.count / 2)
  let isValid = hexValues.withUnsafeBufferPointer { values in
    output.withUnsafeMutableBytes { (rawOutput: UnsafeMutableRawBufferPointer) -> Bool in
      let out = rawOutput.bindMemory(to: UInt8.self)
      for index in 0..<out.count {
        let high = Int32(values[Int(input[index * 2])])
        let low = Int32(values[Int(input[index * 2 + 1])])
        if (high | low) < 0 {
          return false
        }
        out[index] = UInt8(truncatingIfNeeded: (high << 4) | low)
      }
      return true
    }
  }
  return isValid ? output : nil
}
