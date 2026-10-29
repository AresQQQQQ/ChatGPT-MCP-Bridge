import Foundation
import Security

struct Request: Decodable {
    let operation: String
    let target: String
    let username: String?
    let password: String?
}

func fail(_ status: OSStatus) -> Never {
    fputs("Keychain operation failed (\(status))\n", stderr)
    exit(2)
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
let request: Request
do {
    request = try JSONDecoder().decode(Request.self, from: inputData)
} catch {
    fail(errSecParam)
}

guard request.target.hasPrefix("MCPBridge/SSH/"),
      request.target.count <= 256,
      !request.target.contains("\n"),
      !request.target.contains("\0") else {
    fail(errSecParam)
}

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: request.target
]

switch request.operation {
case "save":
    guard let username = request.username,
          !username.isEmpty,
          let password = request.password,
          !password.isEmpty,
          password.utf8.count <= 4800,
          !password.contains("\n"),
          !password.contains("\r"),
          !password.contains("\0") else {
        fail(errSecParam)
    }
    let updateAttributes: [String: Any] = [
        kSecAttrAccount as String: username,
        kSecValueData as String: Data(password.utf8)
    ]
    var status = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        for (key, value) in updateAttributes { item[key] = value }
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)
        }
    }
    guard status == errSecSuccess else { fail(status) }
    FileHandle.standardOutput.write(Data("ok".utf8))

case "read":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { fail(status) }
    FileHandle.standardOutput.write(data)

case "exists":
    var lookup = query
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecSuccess {
        FileHandle.standardOutput.write(Data("yes".utf8))
    } else if status == errSecItemNotFound {
        FileHandle.standardOutput.write(Data("no".utf8))
    } else {
        fail(status)
    }

case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail(status) }
    FileHandle.standardOutput.write(Data("ok".utf8))

default:
    fail(errSecParam)
}
