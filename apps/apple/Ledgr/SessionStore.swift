import Foundation
import Security

/// Holds the sign-in cookies ourselves, in the Keychain.
///
/// Ledgr marks its session cookie Secure when the server's public address is
/// https, but the app also signs in over plain http at home. Cookie stores
/// refuse Secure cookies on http addresses (except localhost), so relying on
/// them would silently drop the session there. The session token is valid on
/// every address, so we keep one copy and attach it to our own requests.
enum SessionStore {
    private static let service = "com.dbullard.ledgr"
    private static let account = "session-cookies"

    static func load() -> [String: String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let map = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return map
    }

    static func save(_ cookies: [String: String]) {
        clear()
        guard !cookies.isEmpty, let data = try? JSONEncoder().encode(cookies) else { return }
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(add as CFDictionary, nil)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
