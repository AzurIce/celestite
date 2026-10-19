#!/usr/bin/env python3
"""Run the embedded Tauri application in a real WebKitGTK WebView.

Build first with `bun run --cwd web tauri build --debug --no-bundle`.
This harness uses W3C WebDriver directly and only Python's standard library.
All documents, settings, credentials, and application data are isolated under
the output directory. No application test commands or production hooks exist.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import traceback
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid


ROOT = Path(__file__).resolve().parents[1]
INITIAL = "# Desktop smoke\n\nInitial native content.\n"
SAVED = "\nSaved through the native editor.\n"
DRAFT = "\nPersisted draft after interrupted desktop session.\n"


def eventually(check, description, timeout=30):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (AssertionError, URLError, OSError, RuntimeError) as error:
            last_error = error
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {description}; last error: {last_error}")


def unused_port():
    with socket.socket() as channel:
        channel.bind(("127.0.0.1", 0))
        return channel.getsockname()[1]


def json_http(url, method="GET", payload=None, timeout=35):
    data = None if payload is None else json.dumps(payload).encode()
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except HTTPError as error:
        raw = error.read()
        raise RuntimeError(f"WebDriver {method} {url}: {error.code} {raw.decode(errors='replace')}") from error
    result = json.loads(raw) if raw else {}
    value = result.get("value", result)
    if isinstance(value, dict) and "error" in value:
        raise RuntimeError(f"WebDriver: {value}")
    return value


class Browser:
    def __init__(self, driver, binary, environment, output, phase):
        self.log = (output / f"webdriver-{phase}.log").open("wb")
        self.port = unused_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.process = subprocess.Popen(
            [driver, f"--port={self.port}"], env=environment,
            stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        self.session = None
        try:
            eventually(lambda: self.status(), "WebKitWebDriver startup", timeout=15)
            created = json_http(self.base + "/session", "POST", {
                "capabilities": {"alwaysMatch": {
                    "browserName": "wry",
                    "webkitgtk:browserOptions": {"binary": str(binary), "args": []},
                }},
            }, timeout=60)
            self.session = created["sessionId"]
            self.call("timeouts", "POST", {"script": 30000, "implicit": 0, "pageLoad": 30000})
        except Exception:
            self.stop()
            raise

    def status(self):
        if self.process.poll() is not None:
            raise RuntimeError("WebKitWebDriver exited; inspect its log")
        return json_http(self.base + "/status", timeout=1).get("ready", False)

    def call(self, path, method="GET", payload=None):
        return json_http(f"{self.base}/session/{self.session}/{path}", method, payload)

    def js(self, script, *args):
        return self.call("execute/sync", "POST", {"script": script, "args": list(args)})

    def async_js(self, script, *args):
        wrapped = """
        const values = Array.from(arguments), done = values.pop();
        (async (args) => { SCRIPT })(values).then(
          value => done({ok: true, value: value === undefined ? null : value}),
          error => done({ok: false, error: String(error?.stack || error)})
        );
        """.replace("SCRIPT", script)
        result = self.call("execute/async", "POST", {"script": wrapped, "args": list(args)})
        if not result or not result.get("ok"):
            raise AssertionError(f"WebView script failed: {result}")
        return result.get("value")

    def invoke(self, command, **params):
        return self.async_js("return await window.__TAURI_INTERNALS__.invoke(args[0], args[1]);", command, params)

    def screenshot(self, output, name):
        path = output / name
        path.write_bytes(base64.b64decode(self.call("screenshot")))
        return str(path)

    def bootstrap(self):
        eventually(lambda: self.js("return !!window.__TAURI_INTERNALS__ && !!document.querySelector('[role=tree]');"), "native workspace")
        self.js("""
          const fetch = window.fetch.bind(window);
          window.desktopSmoke = {calls: [], errors: [], handles: [], clientId: null};
          window.fetch = function(url, options, ...rest) {
            const address = new URL(typeof url === 'string' || url instanceof URL ? String(url) : url.url);
            if (address.protocol === 'ipc:' || address.hostname === 'ipc.localhost') {
              let params = {};
              try { params = JSON.parse(options?.body || '{}'); } catch {}
              const command = decodeURIComponent(address.pathname.slice(1));
              const audit = window.desktopSmoke;
              audit.calls.push({command, method: params?.method, handle: params?.handle,
                path: params?.params?.path, time: Date.now()});
              if (params?.handle && !audit.handles.includes(params.handle)) audit.handles.push(params.handle);
              if (command === 'desktop_open') audit.clientId = params?.clientId;
            }
            return fetch(url, options, ...rest);
          };
          window.addEventListener('error', event => window.desktopSmoke.errors.push(String(event.error || event.message)));
          window.addEventListener('unhandledrejection', event => window.desktopSmoke.errors.push(String(event.reason)));
          return true;
        """)

    def open_file(self, name):
        selector = f'[role="treeitem"][aria-label={json.dumps(name)}] [data-path]'
        eventually(lambda: self.js("return !!document.querySelector(arguments[0]);", selector), f"file tree entry {name}")
        self.js("document.querySelector(arguments[0]).click();", selector)
        eventually(lambda: self.js("return !!document.querySelector('.cm-content')?.cmTile?.root?.view;"), f"CodeMirror for {name}")
        eventually(lambda: self.js("return !!document.querySelector('[role=tab][aria-selected=true][aria-label=' + JSON.stringify(arguments[0]) + ']');", name), f"selected editor tab {name}")

    def text(self):
        return self.js("return document.querySelector('.cm-content')?.cmTile?.root?.view.state.doc.toString();")

    def append(self, text):
        self.js("""
          const view = document.querySelector('.cm-content').cmTile.root.view;
          view.focus();
          view.dispatch({changes: {from: view.state.doc.length, insert: arguments[0]}});
        """, text)

    def button(self, label):
        eventually(lambda: self.js("return [...document.querySelectorAll('button')].some(button => button.textContent.trim() === arguments[0] && !button.disabled);", label), f"enabled button {label}")
        self.js("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === arguments[0] && !button.disabled).click();", label)

    def undo(self):
        self.js("document.querySelector('.cm-content').cmTile.root.view.focus();")
        self.call("actions", "POST", {"actions": [{"type": "key", "id": "keyboard", "actions": [
            {"type": "keyDown", "value": "\ue009"}, {"type": "keyDown", "value": "z"},
            {"type": "keyUp", "value": "z"}, {"type": "keyUp", "value": "\ue009"},
        ]}]})
        self.call("actions", "DELETE")

    def document(self, name):
        handles = self.js("return window.desktopSmoke.handles;")
        for handle in handles:
            reply = self.invoke("desktop_core", handle=handle, method="resident", params={})
            if reply.get("status") != "ok":
                continue
            for item in reply["value"]:
                if item["path"] == name:
                    return handle, item
        return None

    def select_vault(self, identifier):
        self.js("""
          const select = document.querySelector('select[aria-label="当前 Vault"]');
          if (![...select.options].some(option => option.value === arguments[0])) throw Error('Missing Vault option ' + arguments[0]);
          select.value = arguments[0];
          select.dispatchEvent(new Event('change', {bubbles: true}));
        """, identifier)

    def save_trace(self, output, phase):
        data = self.js("return window.desktopSmoke;")
        (output / f"ipc-{phase}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))
        return data

    def stop(self):
        # Kill the complete process group: crash recovery must not trigger the
        # application's ordinary close/save handlers. Each driver has its own.
        if self.process.poll() is None:
            pending = [self.process.pid]
            children = []
            while pending:
                parent = pending.pop()
                try:
                    discovered = [int(pid) for pid in Path(f"/proc/{parent}/task/{parent}/children").read_text().split()]
                except OSError:
                    continue
                children.extend(discovered)
                pending.extend(discovered)
            # WebKit subprocesses may create their own groups. Kill only this
            # driver's descendants as well as its isolated process group.
            for child in reversed(children):
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=10)
        self.log.close()


def request_native_close(display):
    """Send the same WM_DELETE_WINDOW client message as an X11 window manager."""
    candidates = [ctypes.util.find_library("X11"), "libX11.so.6"]
    candidates.extend(str(path) for path in Path("/nix/store").glob("*-libX11-*/lib/libX11.so.6"))
    library = None
    for candidate in filter(None, candidates):
        try:
            library = ctypes.CDLL(candidate)
            break
        except OSError:
            continue
    if library is None:
        raise RuntimeError("Cannot load libX11 to exercise the native window close event")

    class Data(ctypes.Union):
        _fields_ = [("bytes", ctypes.c_char * 20), ("longs", ctypes.c_long * 5)]

    class ClientMessage(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                    ("display", ctypes.c_void_p), ("window", ctypes.c_ulong),
                    ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("data", Data)]

    class Event(ctypes.Union):
        _fields_ = [("client", ClientMessage), ("padding", ctypes.c_long * 24)]

    library.XOpenDisplay.argtypes = [ctypes.c_char_p]
    library.XOpenDisplay.restype = ctypes.c_void_p
    library.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    library.XDefaultRootWindow.restype = ctypes.c_ulong
    library.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                  ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
                                  ctypes.POINTER(ctypes.c_uint)]
    library.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p)]
    library.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    library.XInternAtom.restype = ctypes.c_ulong
    library.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
    library.XFlush.argtypes = [ctypes.c_void_p]
    library.XFree.argtypes = [ctypes.c_void_p]
    library.XCloseDisplay.argtypes = [ctypes.c_void_p]
    connection = library.XOpenDisplay(display.encode())
    if not connection:
        raise RuntimeError(f"Cannot open X11 display {display}")
    try:
        pending = [library.XDefaultRootWindow(connection)]
        found = None
        for _ in range(512):
            if not pending:
                break
            window = pending.pop()
            title = ctypes.c_void_p()
            if library.XFetchName(connection, window, ctypes.byref(title)) and title.value:
                name = ctypes.string_at(title).decode(errors="replace")
                library.XFree(title)
                if name.lower() == "celestite":
                    found = window
                    break
            root, parent = ctypes.c_ulong(), ctypes.c_ulong()
            children = ctypes.POINTER(ctypes.c_ulong)()
            count = ctypes.c_uint()
            if library.XQueryTree(connection, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
                pending.extend(children[index] for index in range(count.value))
                if children:
                    library.XFree(children)
        if found is None:
            raise RuntimeError("Cannot find the native Celestite toplevel window")
        event = Event()
        event.client.type = 33  # ClientMessage
        event.client.send_event = 1
        event.client.display = connection
        event.client.window = found
        event.client.message_type = library.XInternAtom(connection, b"WM_PROTOCOLS", 0)
        event.client.format = 32
        event.client.data.longs[0] = library.XInternAtom(connection, b"WM_DELETE_WINDOW", 0)
        if not library.XSendEvent(connection, found, 0, 0, ctypes.byref(event)):
            raise RuntimeError("X11 rejected WM_DELETE_WINDOW")
        library.XFlush(connection)
    finally:
        library.XCloseDisplay(connection)


def check_component_protocol(browser):
    return browser.async_js("""
      const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
      const scope = 'smoke-' + crypto.randomUUID(), digest = 'a'.repeat(64);
      const directory = 'vault/库 空间/components/probe';
      const encode = text => Array.from(new TextEncoder().encode(text));
      const wasm = [0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11];
      const files = [
        {path: directory + '/index.js', data: encode(`import {answer} from './dep.js'; export {answer}; export const wasmUrl = new URL('./probe.wasm', import.meta.url).href;`)},
        {path: directory + '/dep.js', data: encode('export const answer = 42;')},
        {path: directory + '/probe.wasm', data: wasm},
      ];
      await invoke('desktop_assets_register', {scope, digest, files});
      try {
        // Exactly the production convertFileSrc origin and per-segment URL
        // encoding. Relative ESM imports must retain real directory separators.
        const origin = new URL('/', window.__TAURI_INTERNALS__.convertFileSrc('', 'celestite-preview'));
        const url = new URL([scope, digest, ...directory.split('/'), 'index.js'].map(encodeURIComponent).join('/'), origin).href;
        const module = await import(url);
        const response = await fetch(module.wasmUrl);
        const type = response.headers.get('content-type');
        const streaming = await WebAssembly.instantiateStreaming(Promise.resolve(response), {});
        if (module.answer !== 42 || streaming.instance.exports.answer() !== 42 || type !== 'application/wasm')
          throw Error('Relative ESM / streaming WASM result or MIME type differs');
        return {url, wasmUrl: module.wasmUrl, answer: module.answer, wasm: streaming.instance.exports.answer(), type};
      } finally { await invoke('desktop_assets_clear', {scope}); }
    """)


def start_xvfb(binary, environment, output):
    display = next((f":{index}" for index in range(101, 201) if not Path(f"/tmp/.X11-unix/X{index}").exists()), None)
    if display is None:
        raise RuntimeError("No unused X11 display in :101..:200")
    log = (output / "xvfb.log").open("wb")
    process = subprocess.Popen([binary, display, "-screen", "0", "1440x1000x24", "-nolisten", "tcp", "-ac"],
                               env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        eventually(lambda: process.poll() is None and Path(f"/tmp/.X11-unix/X{display[1:]}").exists(), "Xvfb startup", timeout=10)
    except Exception:
        process.terminate()
        process.wait(timeout=5)
        log.close()
        raise
    return display, process, log


def start_remote(binary, workspace, output, environment):
    root = workspace / "remote-files"
    root.mkdir()
    (root / "remote.md").write_text("# Remote desktop smoke\n")
    port = unused_port()
    log_path = output / "server.log"
    log = log_path.open("wb")
    process = subprocess.Popen([str(binary), "--no-config", "--vault", str(root), "--no-web",
                               "--allowed-origin", "tauri://localhost",
                               "--listen", f"127.0.0.1:{port}", "--name", "Harness Remote"],
                              env=dict(environment, RUST_LOG="info"), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    def connection():
        if process.poll() is not None:
            raise RuntimeError("Remote server exited; inspect server.log")
        match = re.search(r'edit_url=(https?://[^\s"\x1b]+)', log_path.read_text(errors="replace"))
        return match.group(1) if match else None
    try:
        url = eventually(connection, "remote share URL", timeout=15)
    except Exception:
        process.terminate()
        process.wait(timeout=5)
        log.close()
        raise
    return process, log, root, url


def parser():
    command = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    command.add_argument("--binary", type=Path, default=ROOT / "target/debug/celestite", help="embedded Tauri binary (build --debug --no-bundle first)")
    command.add_argument("--output", type=Path, required=True, help="PNG screenshots, report, logs, and isolated data directory")
    command.add_argument("--webdriver", default=os.environ.get("WEBKIT_WEBDRIVER") or shutil.which("WebKitWebDriver"), help="WebKitWebDriver executable; defaults to WEBKIT_WEBDRIVER or PATH")
    command.add_argument("--xvfb", default=shutil.which("Xvfb"), help="Xvfb executable; not needed with --display")
    command.add_argument("--display", help="use an existing X11 display instead of starting Xvfb")
    command.add_argument("--server-binary", type=Path, help="optional celestite-server binary for an isolated real remote-Vault phase")
    command.add_argument("--skip-close-guard", action="store_true", help="skip native WM_DELETE_WINDOW failure injection (e.g. privileged runners)")
    return command


def main():
    options = parser().parse_args()
    binary = options.binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise SystemExit(f"Missing executable: {binary}; build Tauri --debug --no-bundle first")
    if options.server_binary and (not options.server_binary.is_file() or not os.access(options.server_binary, os.X_OK)):
        raise SystemExit(f"Missing server executable: {options.server_binary}; cargo build -p celestite-server first")
    if not options.webdriver:
        raise SystemExit("Set WEBKIT_WEBDRIVER or pass --webdriver /path/to/WebKitWebDriver")
    if not options.display and not options.xvfb:
        raise SystemExit("Install Xvfb, pass --xvfb, or use --display")
    if not options.skip_close_guard and os.geteuid() == 0:
        raise SystemExit("The save-failure injection requires an unprivileged user, or --skip-close-guard")
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="workspace-", dir=output))
    app_data = workspace / "application-data"
    files = app_data / "default/files"
    files.mkdir(parents=True)
    smoke = files / "smoke.md"
    smoke.write_text(INITIAL)
    application = app_data / "application"
    application.mkdir()
    (application / "settings.json").write_text(json.dumps({"theme.mode": "dark", "editor.previewMode": "split"}))
    local = workspace / "local-files"
    local.mkdir()
    (local / "local.md").write_text("# Linked local directory\n")
    local_id = f"directory:{uuid.uuid4()}"
    connections = [{"id": local_id, "kind": "directory", "name": "Harness Local", "path": str(local)}]
    environment = dict(os.environ, CELESTITE_APP_DATA_DIR=str(app_data), TAURI_WEBVIEW_AUTOMATION="true",
                       GDK_BACKEND="x11", WEBKIT_DISABLE_DMABUF_RENDERER="1", RUST_BACKTRACE="1")
    display_process = display_log = remote_process = remote_log = browser = None
    report = {"binary": str(binary), "workspace": str(workspace), "checks": [], "screenshots": []}
    try:
        if options.display:
            display = options.display
        else:
            display, display_process, display_log = start_xvfb(options.xvfb, environment, output)
        environment["DISPLAY"] = display
        remote_root = remote_id = None
        if options.server_binary:
            remote_process, remote_log, remote_root, remote_url = start_remote(options.server_binary.resolve(), workspace, output, environment)
            remote_id = f"remote:{uuid.uuid4()}"
            connections.append({"id": remote_id, "name": "Harness Remote", "url": remote_url})

        print("Starting native WebView and opening the preseeded default Vault…", flush=True)
        browser = Browser(options.webdriver, binary, environment, output, "first")
        browser.bootstrap()
        browser.open_file("smoke.md")
        assert browser.text() == INITIAL
        browser.append(SAVED)
        browser.button("保存")
        eventually(lambda: smoke.read_text() == INITIAL + SAVED, "native file save")
        browser.undo()
        eventually(lambda: browser.text() == INITIAL, "native undo reflected in CodeMirror")
        eventually(lambda: browser.document("smoke.md"), "native editor handle")
        handle, document = browser.document("smoke.md")
        document_id = document["id"]
        browser.button("保存")
        eventually(lambda: smoke.read_text() == INITIAL, "saved undo checkpoint")
        eventually(lambda: browser.js("""
          return [...document.querySelectorAll('.preview-scroller *')].some(element =>
            element.shadowRoot?.textContent.includes('Desktop smoke'));
        """), "native preview output mounted in its shadow root")
        report["checks"].append("default UI open, CodeMirror edit, native save/undo, native preview")
        report["screenshots"].append(browser.screenshot(output, "01-native-editor-preview.png"))

        print("Checking custom-scheme relative ESM, Unicode URLs, and streaming WASM…", flush=True)
        report["componentProtocol"] = check_component_protocol(browser)
        report["checks"].append("registered native component bytes, relative ESM, streaming WASM MIME and result")
        settings = json.loads(browser.invoke("desktop_app_read", name="settings.json"))
        settings["harness.marker"] = "real-native-ipc"
        browser.invoke("desktop_app_write", name="settings.json", document=settings)
        browser.invoke("desktop_app_write", name="connections.json", document={"version": 2, "connections": connections})
        assert json.loads(browser.invoke("desktop_app_read", name="settings.json"))["harness.marker"] == "real-native-ipc"
        assert json.loads(browser.invoke("desktop_app_read", name="connections.json"))["connections"] == connections
        report["checks"].append("settings and connection objects persisted through real native IPC")
        identity = json.loads((app_data / "default/history/instance.json").read_text())

        print("Creating a durable unsaved draft and checking native close failure handling…", flush=True)
        # Replacements prepare a sibling temporary file and atomically rename
        # it. Deny writes to the directory so the injection covers that actual
        # publication strategy while keeping files readable after restart.
        files.chmod(0o500)
        browser.append(DRAFT)
        def checkpointed_draft():
            state = browser.document("smoke.md")
            if not state:
                return None
            document = state[1]
            drafts = [json.loads(path.read_text()) for path in (app_data / "default/history/recovery").glob("*.json")]
            protected = any(draft["path"] == "smoke.md" and draft["text"] == INITIAL + DRAFT for draft in drafts)
            return document if protected and document["dirty"] and not document.get("recoveryError") and document["snapshot"]["text"] == INITIAL + DRAFT else None
        eventually(checkpointed_draft, "plaintext draft checkpointed")
        if not options.skip_close_guard:
            request_native_close(display)
            eventually(lambda: browser.js("return [...document.querySelectorAll('[role=alert]')].some(element => element.title.includes('窗口仍保留'));"), "failed-close guard keeping the native window open")
            assert browser.text() == INITIAL + DRAFT
            assert smoke.read_text() == INITIAL
            report["checks"].append("real native WM_DELETE_WINDOW preserves the window and draft after save failure")
        report["screenshots"].append(browser.screenshot(output, "02-close-guard-preserves-draft.png"))
        trace = browser.save_trace(output, "first")
        commands = {call["command"] for call in trace["calls"]}
        assert {"desktop_core", "desktop_preview", "desktop_preview_render"} <= commands
        browser.stop()
        browser = None

        print("Restarting the actual application and recovering the unsaved draft…", flush=True)
        browser = Browser(options.webdriver, binary, environment, output, "restart")
        browser.bootstrap()
        browser.open_file("smoke.md")
        eventually(lambda: browser.text() == INITIAL + DRAFT, "recovered draft in the real editor")
        state = eventually(lambda: browser.document("smoke.md"), "recovered native document")
        assert state[1]["id"] != document_id
        document_id = state[1]["id"]
        assert json.loads((app_data / "default/history/instance.json").read_text()) == identity
        assert json.loads(browser.invoke("desktop_app_read", name="settings.json"))["harness.marker"] == "real-native-ipc"
        assert smoke.read_text() == INITIAL
        report["checks"].append("process crash/restart restores plaintext draft and stable instance metadata with a new CRDT identity")
        report["screenshots"].append(browser.screenshot(output, "03-recovered-native-draft.png"))
        files.chmod(0o700)
        browser.button("保存")
        eventually(lambda: smoke.read_text() == INITIAL + DRAFT, "recovered draft saved after permissions recover")

        print("Reloading the WebView while retaining the native owner…", flush=True)
        before_reload = browser.document("smoke.md")[0]
        browser.call("refresh", "POST", {})
        browser.bootstrap()
        browser.open_file("smoke.md")
        eventually(lambda: browser.text() == INITIAL + DRAFT, "native document after WebView reload")
        eventually(lambda: browser.js("""
          return [...document.querySelectorAll('.preview-scroller *')].some(element =>
            element.shadowRoot?.textContent.includes('Persisted draft'));
        """), "fresh preview event stream after WebView reload")
        after_reload = eventually(lambda: browser.document("smoke.md"), "reused native owner")
        assert before_reload == after_reload[0]
        assert after_reload[1]["id"] == document_id
        report["checks"].append("WebView reload reuses native owner, preserves document identity, and starts a fresh working preview stream")

        print("Opening the persisted native directory connection through the actual UI…", flush=True)
        browser.select_vault(local_id)
        browser.open_file("local.md")
        browser.append("\nSaved to the linked native directory.\n")
        browser.button("保存")
        eventually(lambda: "Saved to the linked native directory." in (local / "local.md").read_text(), "linked directory save")
        report["checks"].append("persisted native directory connection selected in UI and saved to its actual directory")
        report["screenshots"].append(browser.screenshot(output, "04-native-directory.png"))
        external = "\nObserved change from an external program.\n"
        path = local / "local.md"
        path.write_text(path.read_text() + external)
        eventually(lambda: external.strip() in browser.text(), "native filesystem watcher reconciles external change")
        report["checks"].append("native filesystem watch reconciles an external file edit into the live editor")
        if remote_id:
            print("Checking the real remote server through the native replica owner…", flush=True)
            browser.select_vault(remote_id)
            browser.open_file("remote.md")
            browser.append("\nSaved through the native remote replica.\n")
            browser.button("保存")
            eventually(lambda: "Saved through the native remote replica." in (remote_root / "remote.md").read_text(), "remote server save")
            eventually(lambda: browser.js("""
              return [...document.querySelectorAll('.preview-scroller *')].some(element =>
                element.shadowRoot?.textContent.includes('Saved through the native remote replica.'));
            """), "remote document rendered by native preview")
            report["checks"].append("real HTTP/WebSocket remote Vault edits, saves, presence, and preview through the native replica")
            report["screenshots"].append(browser.screenshot(output, "05-native-remote.png"))
        browser.save_trace(output, "restart")
        if not options.skip_close_guard:
            request_native_close(display)
            def closed():
                try:
                    return not browser.call("window/handles")
                except RuntimeError as error:
                    return any(message in str(error).lower() for message in ["no such window", "invalid session", "disconnected"])
            eventually(closed, "successful native window close after all saves")
            report["checks"].append("native close succeeds after errors are resolved and all Vaults save")
        report["ok"] = True
        print(f"Passed {len(report['checks'])} native acceptance groups. Artifacts: {output}", flush=True)
    except Exception:
        report["ok"] = False
        report["error"] = traceback.format_exc()
        if browser:
            try:
                browser.screenshot(output, "failure.png")
                (output / "failure.html").write_text(browser.call("source"))
                browser.save_trace(output, "failure")
            except Exception:
                pass
        raise
    finally:
        files.chmod(0o700)
        if browser:
            browser.stop()
        for process in [remote_process, display_process]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for log in [remote_log, display_log]:
            if log:
                log.close()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
