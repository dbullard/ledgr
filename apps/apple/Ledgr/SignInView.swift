import SwiftUI

struct SignInView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var connection: Connection
    @EnvironmentObject var actions: AppActions
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image("LaunchMark")
                .resizable()
                .scaledToFit()
                .frame(width: 84, height: 84)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            VStack(spacing: 4) {
                Text("Ledgr").font(.largeTitle.bold())
                Text("Sign in to your account").foregroundStyle(.secondary)
            }
            VStack(spacing: 12) {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    #endif
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
                    .padding(12)
                    .background(Color.card, in: RoundedRectangle(cornerRadius: 12))
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { Task { await signIn() } }
                    .padding(12)
                    .background(Color.card, in: RoundedRectangle(cornerRadius: 12))
                if let error = error ?? api.lastIssue {
                    Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                }
                Button {
                    Task { await signIn() }
                } label: {
                    Group {
                        if busy { ProgressView() } else { Text("Sign in").fontWeight(.semibold) }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy || email.isEmpty || password.isEmpty || connection.active == nil)
            }
            .frame(maxWidth: 380)

            HStack(spacing: 6) {
                Image(systemName: connection.mode.symbol)
                Text(connection.mode == .offline ? "Can't reach your server" : connection.mode.label)
            }
            .font(.footnote)
            .foregroundStyle(connection.mode == .offline ? .red : .secondary)
            Button("Server settings") { actions.showSettings = true }
                .font(.footnote)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.canvas)
    }

    private func signIn() async {
        guard !busy else { return }
        busy = true
        error = nil
        do {
            try await api.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
            password = ""
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
