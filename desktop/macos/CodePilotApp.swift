import AppKit
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private var stdoutBuffer = ""
    private var logHandle: FileHandle?
    private var isQuitting = false
    private var buildLabel = "unknown"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        createWindow()
        startBackend()
    }

    func applicationWillTerminate(_ notification: Notification) {
        isQuitting = true
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
        try? logHandle?.close()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func createWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true

        let frame = NSRect(x: 0, y: 0, width: 1320, height: 860)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "CodePilot"
        window.center()
        window.minSize = NSSize(width: 1040, height: 680)

        let webView = WKWebView(frame: frame, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
        self.webView = webView
        showLoading()
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "Quit CodePilot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        NSApp.mainMenu = mainMenu
    }

    private func showLoading() {
        webView?.loadHTMLString("""
        <!doctype html>
        <meta charset="utf-8">
        <style>
        body { margin: 0; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; background: #fafafa; }
        main { height: 100vh; display: grid; place-items: center; }
        section { width: 360px; padding: 24px; border: 1px solid #e5e5e5; border-radius: 8px; background: white; }
        h1 { margin: 0 0 8px; font-size: 18px; }
        p { margin: 0; color: #666; line-height: 1.6; }
        code { background: #f3f3f3; padding: 1px 4px; border-radius: 4px; }
        </style>
        <main><section><h1>Starting CodePilot</h1><p>Launching local agent runtime...</p></section></main>
        """, baseURL: nil)
    }

    private func showError(_ message: String) {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        webView?.loadHTMLString("""
        <!doctype html>
        <meta charset="utf-8">
        <style>
        body { margin: 0; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; background: #fafafa; }
        main { height: 100vh; display: grid; place-items: center; }
        section { max-width: 720px; padding: 24px; border: 1px solid #e5e5e5; border-radius: 8px; background: white; }
        h1 { margin: 0 0 8px; font-size: 18px; color: #b91c1c; }
        pre { white-space: pre-wrap; color: #555; background: #f7f7f7; padding: 12px; border-radius: 6px; }
        </style>
        <main><section><h1>CodePilot failed to start</h1><pre>\(escaped)</pre></section></main>
        """, baseURL: nil)
    }

    private func startBackend() {
        guard let resourcePath = Bundle.main.resourcePath else {
            showError("Bundle resource path is unavailable.")
            return
        }
        buildLabel = readBuildLabel(resourcePath: resourcePath)

        let runtimePath = URL(fileURLWithPath: resourcePath).appendingPathComponent("runtime").path
        let serverPath = URL(fileURLWithPath: runtimePath).appendingPathComponent("src/agent-server/server.mjs").path
        let nodePath = findNode(resourcePath: resourcePath)
        guard FileManager.default.isExecutableFile(atPath: nodePath) else {
            showError("Node.js was not found. Add a bundled node at Resources/node/bin/node or install Node in /opt/homebrew/bin/node or /usr/local/bin/node.")
            return
        }
        guard FileManager.default.fileExists(atPath: serverPath) else {
            showError("Runtime server is missing at \(serverPath).")
            return
        }

        let productHome = applicationSupportPath()
        ensureProductHome(productHome: productHome, runtimePath: runtimePath)
        let logPath = URL(fileURLWithPath: productHome).appendingPathComponent("desktop.log").path
        FileManager.default.createFile(atPath: logPath, contents: nil)
        logHandle = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath))
        log("Build=\(buildLabel)")
        log("Starting backend with node=\(nodePath)")
        log("Runtime=\(runtimePath)")
        log("ProductHome=\(productHome)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [
            serverPath,
            "--host", "127.0.0.1",
            "--port", "0",
            "--product-home", productHome,
        ]
        process.currentDirectoryURL = URL(fileURLWithPath: runtimePath)
        var environment = ProcessInfo.processInfo.environment
        environment["INTERNAL_CODEX_DESKTOP"] = "1"
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.handleStdout(text)
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.log(text)
            }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !self.isQuitting else { return }
                self.showError("Backend exited with status \(proc.terminationStatus).\nBuild: \(self.buildLabel)\nSee \(logPath).")
            }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            showError("Failed to launch backend: \(error.localizedDescription)")
        }
    }

    private func handleStdout(_ text: String) {
        log(text)
        stdoutBuffer += text
        while let newline = stdoutBuffer.firstIndex(of: "\n") {
            let line = String(stdoutBuffer[..<newline])
            stdoutBuffer.removeSubrange(...newline)
            if let url = parseStartupUrl(line) {
                loadApp(url: url)
            }
        }
    }

    private func parseStartupUrl(_ line: String) -> URL? {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let urlString = json["url"] as? String else {
            return nil
        }
        return URL(string: urlString)
    }

    private func loadApp(url: URL) {
        log("Loading \(url.absoluteString)")
        webView?.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if shouldOpenExternally(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = navigationAction.request.url else {
            return nil
        }
        if shouldOpenExternally(url) {
            NSWorkspace.shared.open(url)
        } else {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    private func shouldOpenExternally(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host?.lowercased() else {
            return false
        }
        return host != "127.0.0.1" && host != "localhost" && host != "::1"
    }

    private func findNode(resourcePath: String) -> String {
        let candidates = [
            ProcessInfo.processInfo.environment["CODEPILOT_NODE"],
            URL(fileURLWithPath: resourcePath).appendingPathComponent("node/bin/node").path,
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ].compactMap { $0 }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? ""
    }

    private func readBuildLabel(resourcePath: String) -> String {
        let buildInfoPath = URL(fileURLWithPath: resourcePath).appendingPathComponent("build-info.json").path
        guard let data = FileManager.default.contents(atPath: buildInfoPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return "unknown"
        }
        let version = json["version"] as? String ?? "unknown"
        let buildId = json["buildId"] as? String ?? "unknown"
        return "\(version) \(buildId)"
    }

    private func applicationSupportPath() -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("CodePilot", isDirectory: true).path
    }

    private func ensureProductHome(productHome: String, runtimePath: String) {
        try? FileManager.default.createDirectory(atPath: productHome, withIntermediateDirectories: true)
        let envPath = URL(fileURLWithPath: productHome).appendingPathComponent(".env.local").path
        let examplePath = URL(fileURLWithPath: runtimePath).appendingPathComponent(".env.local.example").path
        if !FileManager.default.fileExists(atPath: envPath) {
            if let data = FileManager.default.contents(atPath: examplePath) {
                FileManager.default.createFile(atPath: envPath, contents: data)
            } else {
                FileManager.default.createFile(atPath: envPath, contents: Data())
            }
        }
        mergeBundledEnvValues(envPath: envPath, templatePath: examplePath)
    }

    private func mergeBundledEnvValues(envPath: String, templatePath: String) {
        guard let templateText = try? String(contentsOfFile: templatePath, encoding: .utf8),
              !templateText.isEmpty else {
            return
        }
        var lines = ((try? String(contentsOfFile: envPath, encoding: .utf8)) ?? "")
            .components(separatedBy: .newlines)
        var entries: [String: (index: Int, value: String)] = [:]
        for (index, line) in lines.enumerated() {
            if let parsed = parseEnvLine(line) {
                entries[parsed.key] = (index, parsed.value)
            }
        }

        var changedKeys: [String] = []
        for templateLine in templateText.components(separatedBy: .newlines) {
            guard let parsed = parseEnvLine(templateLine), !parsed.value.isEmpty else {
                continue
            }
            if let existing = entries[parsed.key] {
                if existing.value.isEmpty {
                    lines[existing.index] = "\(parsed.key)=\(parsed.value)"
                    changedKeys.append(parsed.key)
                }
            } else {
                if lines.last == "" {
                    lines.removeLast()
                }
                lines.append("\(parsed.key)=\(parsed.value)")
                entries[parsed.key] = (lines.count - 1, parsed.value)
                changedKeys.append(parsed.key)
            }
        }

        if !changedKeys.isEmpty {
            let nextText = lines.joined(separator: "\n") + "\n"
            try? nextText.write(toFile: envPath, atomically: true, encoding: .utf8)
            log("Merged bundled env keys: \(changedKeys.joined(separator: ","))")
        }
    }

    private func parseEnvLine(_ line: String) -> (key: String, value: String)? {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed.hasPrefix("#") {
            return nil
        }
        if trimmed.hasPrefix("export ") {
            trimmed = String(trimmed.dropFirst("export ".count)).trimmingCharacters(in: .whitespaces)
        }
        guard let equalsIndex = trimmed.firstIndex(of: "=") else {
            return nil
        }
        let key = String(trimmed[..<equalsIndex]).trimmingCharacters(in: .whitespaces)
        let value = String(trimmed[trimmed.index(after: equalsIndex)...]).trimmingCharacters(in: .whitespaces)
        guard key.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil else {
            return nil
        }
        return (key, value)
    }

    private func log(_ text: String) {
        let line = text.hasSuffix("\n") ? text : "\(text)\n"
        guard let data = line.data(using: .utf8) else { return }
        do {
            try logHandle?.seekToEnd()
            try logHandle?.write(contentsOf: data)
        } catch {
            // Logging must never prevent the desktop shell from starting.
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
