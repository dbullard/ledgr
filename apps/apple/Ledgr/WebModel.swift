import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Owns the single WKWebView that shows the real Ledgr web app, so the native
/// apps are an exact mirror of what runs in the container.
@MainActor
final class WebModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published var isLoading = false
    @Published var canGoBack = false
    @Published var loadError: String?
    var allowedHosts: Set<String> = []
    private var currentBase: URL?

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "LedgrNative/1.0"
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        #if os(iOS)
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        #endif
    }

    #if os(iOS)
    @objc private func pullToRefresh(_ control: UIRefreshControl) {
        reload()
        control.endRefreshing()
    }
    #endif

    /// Points the web view at `base`, keeping the current page when the address
    /// changes mid-session (home <-> away).
    func open(base: URL) {
        defer { currentBase = base }
        // Nothing shown yet: just remember the address; pages load on demand.
        if webView.url == nil { return }
        if let current = webView.url, let old = currentBase, current.host == old.host, current.port == old.port {
            if old.host == base.host && old.port == base.port && old.scheme == base.scheme { return }
            var parts = URLComponents(url: current, resolvingAgainstBaseURL: false)
            parts?.scheme = base.scheme
            parts?.host = base.host
            parts?.port = base.port
            if let moved = parts?.url {
                webView.load(URLRequest(url: moved))
                return
            }
        }
        webView.load(URLRequest(url: base))
    }

    /// Shows one page of the full web app (the parts without a native screen yet).
    func show(path: String) {
        guard let base = currentBase, let url = URL(string: path, relativeTo: base)?.absoluteURL else { return }
        if let current = webView.url, current.host == url.host, current.port == url.port, current.path == url.path { return }
        webView.load(URLRequest(url: url))
    }

    func reload() {
        if webView.url == nil, let base = currentBase {
            webView.load(URLRequest(url: base))
        } else {
            webView.reload()
        }
    }

    func goBack() { webView.goBack() }

    func clearWebsiteData() async {
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        await store.removeData(ofTypes: types, modifiedSince: .distantPast)
        webView.load(URLRequest(url: currentBase ?? URL(string: "about:blank")!))
    }

    /// Cookies for the address uploads go to, as a Cookie header value.
    func cookieHeader(for url: URL) async -> String? {
        let all = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        let host = url.host?.lowercased() ?? ""
        let mine = all.filter {
            $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == host
        }
        guard !mine.isEmpty else { return nil }
        return HTTPCookie.requestHeaderFields(with: mine)["Cookie"]
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .allow }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "blob", "data"].contains(scheme) { return .allow }
        if let host = url.host?.lowercased(), allowedHosts.contains(host) { return .allow }
        if scheme == "http" || scheme == "https" || scheme == "mailto" || scheme == "tel" {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            #endif
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
        loadError = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        canGoBack = webView.canGoBack
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        let code = (error as NSError).code
        if code != NSURLErrorCancelled { loadError = error.localizedDescription }
    }

    // MARK: WKUIDelegate

    /// target="_blank" links (receipt files) open in the same view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, let host = url.host?.lowercased(), allowedHosts.contains(host) {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    #if os(macOS)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
    #endif
}

#if os(iOS)
struct LedgrWebView: UIViewRepresentable {
    let model: WebModel
    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#else
struct LedgrWebView: NSViewRepresentable {
    let model: WebModel
    func makeNSView(context: Context) -> WKWebView { model.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif
