import AppKit
import WebKit
import Darwin

final class BridgeAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var host: Process?
    private var inputPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var origin: URL?
    private var pendingOutput = Data()
    private var shuttingDown = false
    private var canFinishTermination = false
    private var projectAccess: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let icon = Bundle.main.url(forResource: "bridge", withExtension: "png") { NSApp.applicationIconImage = NSImage(contentsOf: icon) }
        makeMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "chooseFolder")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "closeWizard")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = .windowBackgroundColor
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "ChatGPT MCP Bridge"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 820, height: 650)
        window.backgroundColor = NSColor.windowBackgroundColor
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        authorizeProjectAndLaunch()
    }

    private func makeMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 ChatGPT MCP Bridge", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 ChatGPT MCP Bridge", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 ChatGPT MCP Bridge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); main.addItem(editItem); let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let serviceItem = NSMenuItem(); main.addItem(serviceItem); let service = NSMenu(title: "服务"); serviceItem.submenu = service
        service.addItem(withTitle: "启动 Bridge 与 Tunnel", action: #selector(startServices), keyEquivalent: "r")
        service.addItem(withTitle: "停止 Bridge 与 Tunnel", action: #selector(stopServices), keyEquivalent: ".")
        service.addItem(withTitle: "重新启动", action: #selector(restartServices), keyEquivalent: "")
        let windowItem = NSMenuItem(); main.addItem(windowItem); let windowMenu = NSMenu(title: "窗口"); windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "重新载入控制台", action: #selector(reloadConsole), keyEquivalent: "R")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        NSApp.mainMenu = main; NSApp.windowsMenu = windowMenu
    }
    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "ChatGPT MCP Bridge", .applicationVersion: "0.1.0", .credits: NSAttributedString(string: "本机项目 · Secure MCP Tunnel · Mac 控制台")])
    }
    private func command(_ action: String) {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('native-command',{detail:'\(action)'}))", completionHandler: nil)
    }
    @objc private func reloadConsole() { webView.reload() }
    @objc private func startServices() { command("start") }
    @objc private func stopServices() { command("stop") }
    @objc private func restartServices() { command("restart") }

    private func authorizeProjectAndLaunch() {
        guard let root = Bundle.main.object(forInfoDictionaryKey: "BridgeProjectRoot") as? String else { fail("应用缺少项目目录，请重新构建。"); return }
        let expected = URL(fileURLWithPath: root).standardizedFileURL
        var stale = false
        if let bookmark = UserDefaults.standard.data(forKey: "BridgeProjectBookmark"),
           let saved = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale),
           saved.standardizedFileURL.path == expected.path, !stale {
            _ = saved.startAccessingSecurityScopedResource()
            projectAccess = saved
            launchHost(); return
        }
        let picker = NSOpenPanel()
        picker.title = "打开 Bridge 项目"
        picker.message = "首次打开，请确认此 Bridge 所在的项目文件夹。应用只管理配置中的工作区。"
        picker.prompt = "打开控制台"
        picker.canChooseFiles = false; picker.canChooseDirectories = true; picker.allowsMultipleSelection = false
        picker.directoryURL = expected
        picker.beginSheetModal(for: window) { [weak self] response in
            guard let self = self else { return }
            guard response == .OK, let folder = picker.url else { NSApp.terminate(nil); return }
            guard folder.standardizedFileURL.path == expected.path else { self.fail("请选择此应用对应的 Bridge 项目目录：\(root)"); return }
            _ = folder.startAccessingSecurityScopedResource()
            self.projectAccess = folder
            if let data = try? folder.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) {
                UserDefaults.standard.set(data, forKey: "BridgeProjectBookmark")
            }
            self.launchHost()
        }
    }

    private func launchHost() {
        guard let root = Bundle.main.object(forInfoDictionaryKey: "BridgeProjectRoot") as? String else { fail("应用缺少项目路径，请重新运行 pnpm run ui:build。"); return }
        let hostScript = URL(fileURLWithPath: root).appendingPathComponent("dist/ui/mac-app-host.js").path
        let config = ProcessInfo.processInfo.environment["BRIDGE_UI_CONFIG"] ?? URL(fileURLWithPath: root).appendingPathComponent("mcp-bridge.json").path
        let process = Process(); host = process
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", "cd -- \"$1\" && exec node \"$2\" --config \"$3\"", "bridge-ui", root, hostScript, config]
        inputPipe = Pipe(); stdoutPipe = Pipe(); stderrPipe = Pipe()
        process.standardInput = inputPipe; process.standardOutput = stdoutPipe; process.standardError = stderrPipe
        stdoutPipe?.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        // Drain diagnostics without showing environment, profile or credentials in the UI.
        stderrPipe?.fileHandleForReading.readabilityHandler = { handle in if handle.availableData.isEmpty { handle.readabilityHandler = nil } }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { if self?.shuttingDown == false { self?.fail("本机控制进程已退出。请检查 Node 22+、依赖和 mcp-bridge.json 后重新打开应用。") } }
        }
        do { try process.run() } catch { fail("无法启动 Node。请检查登录 shell 的 PATH，然后重新打开应用。") }
    }
    private func consume(_ data: Data) {
        guard !data.isEmpty, origin == nil else { return }
        pendingOutput.append(data)
        guard let newline = pendingOutput.firstIndex(of: 10) else {
            if pendingOutput.count > 65536 { fail("控制台启动响应无效。") }; return
        }
        let line = pendingOutput.prefix(upTo: newline)
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: String], let address = object["url"], let url = URL(string: address), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { fail("控制台启动响应无效。"); return }
        origin = url
        pendingOutput.removeAll()
        webView.load(URLRequest(url: url))
    }
    private func fail(_ message: String) {
        guard !shuttingDown else { return }
        let alert = NSAlert(); alert.messageText = "无法打开 Bridge 控制台"; alert.informativeText = message; alert.addButton(withTitle: "退出")
        alert.beginSheetModal(for: window) { _ in NSApp.terminate(nil) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = navigationAction.request.url, let source = origin else { decisionHandler(.cancel); return }
        if target.scheme == source.scheme, target.host == source.host, target.port == source.port {
            decisionHandler(.allow)
            return
        }
        // The connection wizard links only to official OpenAI Platform / ChatGPT pages; open them in the user's browser.
        if target.scheme == "https", ["platform.openai.com", "chatgpt.com", "help.openai.com"].contains(target.host ?? "") {
            NSWorkspace.shared.open(target)
        }
        decisionHandler(.cancel)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        if message.name == "closeWizard" {
            guard message.frameInfo.isMainFrame, let source = origin,
                  message.frameInfo.request.url?.host == source.host,
                  message.frameInfo.request.url?.port == source.port else {
                replyHandler(nil, "请求来源无效")
                return
            }
            replyHandler(true, nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
            return
        }
        guard message.name == "chooseFolder", message.frameInfo.isMainFrame, let source = origin, message.frameInfo.request.url?.host == source.host, message.frameInfo.request.url?.port == source.port else { replyHandler(nil, "请求来源无效"); return }
        let picker = NSOpenPanel(); picker.title = "选择项目文件夹"; picker.prompt = "选择"; picker.canChooseFiles = false; picker.canChooseDirectories = true; picker.allowsMultipleSelection = false
        if let current = message.body as? String, !current.isEmpty { picker.directoryURL = URL(fileURLWithPath: current) }
        picker.beginSheetModal(for: window) { result in replyHandler(result == .OK ? picker.url?.path : nil, nil) }
    }
    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) { projectAccess?.stopAccessingSecurityScopedResource() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if canFinishTermination { return .terminateNow }
        if shuttingDown { return .terminateLater }
        shuttingDown = true
        inputPipe?.fileHandleForWriting.closeFile()
        guard let process = host, process.isRunning else { return .terminateNow }
        process.terminate()
        // A host blocked before its initial URL cannot own any Bridge/Tunnel yet.
        // TCC can hold an early filesystem syscall; bound cancellation in this case.
        if origin == nil {
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
        DispatchQueue.global().async { [weak self] in
            process.waitUntilExit()
            DispatchQueue.main.async { self?.canFinishTermination = true; sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}

let application = NSApplication.shared
let delegate = BridgeAppDelegate()
application.delegate = delegate
application.run()
