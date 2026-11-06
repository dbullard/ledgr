import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct RootView: View {
    @EnvironmentObject var connection: Connection
    @EnvironmentObject var web: WebModel
    @EnvironmentObject var queue: UploadQueue
    @EnvironmentObject var actions: AppActions
    @EnvironmentObject var api: API

    @Environment(\.scenePhase) private var scenePhase
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var dropTargeted = false

    var body: some View {
        content
            .overlay(alignment: .bottom) { banner }
            .sheet(isPresented: $actions.showSettings) {
                NavigationStack { SettingsView() }
                    #if os(macOS)
                    .frame(minWidth: 460, minHeight: 520)
                    #endif
            }
            #if os(iOS)
            .fullScreenCover(isPresented: $actions.showScanner) {
                DocumentScanner { pages in
                    if let file = ImageTools.receiptFile(fromScans: pages) {
                        queue.add(data: file.data, filename: "scan-\(UploadQueue.stamp()).\(file.ext)")
                    }
                }
                .ignoresSafeArea()
            }
            #endif
            .photosPicker(isPresented: $actions.showPhotoPicker, selection: $photoItems, matching: .images)
            .fileImporter(isPresented: $actions.showImporter, allowedContentTypes: Self.receiptTypes, allowsMultipleSelection: true) { result in
                if case .success(let urls) = result { urls.forEach { queue.addFile(at: $0) } }
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    for item in items {
                        if let data = try? await item.loadTransferable(type: Data.self) { queue.addImageData(data) }
                    }
                    photoItems = []
                }
            }
            .onChange(of: connection.active) { _, url in
                web.allowedHosts = connection.allowedHosts
                if let url { web.open(base: url) }
            }
            .onChange(of: connection.homeText) { _, _ in web.allowedHosts = connection.allowedHosts }
            .onChange(of: connection.awayText) { _, _ in web.allowedHosts = connection.allowedHosts }
            .onChange(of: queue.items) { _, _ in flush() }
            .onChange(of: api.auth) { _, _ in flush() }
            .onChange(of: connection.mode) { _, _ in flush() }
            .onChange(of: actions.reloadTick) { _, _ in web.reload() }
            .onOpenURL { queue.addFile(at: $0) }
            .onAppear { queue.importSharedInbox() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { queue.importSharedInbox() } }
            .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
                for p in providers {
                    _ = p.loadObject(ofClass: URL.self) { url, _ in
                        if let url { Task { @MainActor in queue.addFile(at: url) } }
                    }
                }
                return true
            }
            .overlay { if dropTargeted { Color.accentColor.opacity(0.12).ignoresSafeArea().allowsHitTesting(false) } }
            .task(id: connection.active) {
                if connection.active != nil { await api.refreshAuth() }
            }
            .task {
                web.allowedHosts = connection.allowedHosts
                if let url = connection.active { web.open(base: url) }
                connection.start()
            }
    }

    static let receiptTypes: [UTType] = [.pdf, .image, .plainText, .emailMessage]

    @ViewBuilder
    private var content: some View {
        if !connection.setupComplete || !connection.isConfigured {
            NavigationStack { SettingsView(firstRun: true) }
        } else {
            switch api.auth {
            case .signedIn: MainView()
            case .signedOut: SignInView()
            case .unknown: connecting
            }
        }
    }

    private var connecting: some View {
        VStack(spacing: 12) {
            if connection.mode == .offline {
                Image(systemName: "wifi.slash").font(.largeTitle)
                Text("Can't reach your server").font(.headline)
                Text("Check your home Wi-Fi or VPN, then try again.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button("Try again") { connection.scheduleRefresh(after: .milliseconds(50)) }
                    .buttonStyle(.borderedProminent)
                Button("Server settings") { actions.showSettings = true }.font(.footnote)
            } else {
                ProgressView()
                Text("Connecting…").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.canvas)
    }

    @ViewBuilder
    private var banner: some View {
        if let text = bannerText {
            Text(text)
                .font(.footnote)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: Capsule())
                .padding(.bottom, 70)
                .onTapGesture { queue.message = nil }
                .transition(.opacity)
        }
    }

    private var bannerText: String? {
        guard api.auth == .signedIn else { return nil }
        if queue.uploading { return "Uploading receipts…" }
        if let m = queue.message { return m }
        return nil
    }

    private func flush() {
        guard api.auth == .signedIn, let base = connection.active, !queue.items.isEmpty else { return }
        Task {
            let cookie = await api.cookieHeader(for: base)
            await queue.flush(to: base, cookie: cookie)
        }
    }
}
