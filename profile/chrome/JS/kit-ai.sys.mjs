// ==UserScript==
// @name           AI assistant: core
// @description    Shared part of the assistant: local MCP server and Claude Code launcher
// ==/UserScript==

// Фоновый модуль fx-autoconfig: загружается один раз при старте браузера.
// Окна (kit-ai.uc.js) берут отсюда KitAI и создают свою панель.
//
// Как это работает:
//   панель → запускает `claude -p` (Claude Code) в папке этого репозитория;
//   Claude Code → вызывает инструменты браузера через MCP-сервер, который
//   слушает только 127.0.0.1 на случайном порту и пускает лишь с токеном.
// Сам браузер в сеть не ходит — к модели обращается Claude Code.

import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

// ---- Пути ----

// Репозиторий: userChrome.css в профиле — симлинк на <repo>/profile/chrome/userChrome.css.
function findRepo() {
  const pref = Services.prefs.getStringPref("kit.ai.repo", "");
  if (pref) {
    return pref;
  }
  const file = Services.dirsvc.get("UChrm", Ci.nsIFile);
  file.append("userChrome.css");
  if (!file.isSymlink()) {
    return null;
  }
  // <repo>/profile/chrome/userChrome.css → <repo>
  let path = file.target;
  for (let i = 0; i < 3; i++) {
    path = PathUtils.parent(path);
  }
  return path;
}

// Личный слой: chrome/user в профиле — ссылка на него (bin/sync).
function findUserDir() {
  const file = Services.dirsvc.get("UChrm", Ci.nsIFile);
  file.append("user");
  if (!file.isSymlink() || !file.exists()) {
    return null;
  }
  file.normalize();
  return file.path;
}

// Личные указания для ИИ (<личный слой>/AGENTS.md) — пустая строка, если их нет.
async function personalAgents() {
  const dir = findUserDir();
  if (!dir) {
    return "";
  }
  try {
    return await IOUtils.readUTF8(PathUtils.join(dir, "AGENTS.md"));
  } catch (e) {
    return "";
  }
}

function searchPath() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  return [
    PathUtils.join(home, ".local", "bin"),
    PathUtils.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

async function findClaude() {
  const pref = Services.prefs.getStringPref("kit.ai.claude-path", "");
  if (pref) {
    return pref;
  }
  try {
    return await Subprocess.pathSearch("claude", { PATH: searchPath() });
  } catch (e) {
    return null;
  }
}

// ---- MCP-сервер (Streamable HTTP, только JSON-ответы) ----

const decoder = new TextDecoder();
const encoder = new TextEncoder();

class McpServer {
  // tools: [{ name, description, inputSchema }]; onCall(name, args) → Promise<content[]>
  constructor({ tools, onCall }) {
    this.tools = tools;
    this.onCall = onCall;
    this.token = Services.uuid.generateUUID().toString().slice(1, -1);
    this.socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    this.socket.init(-1, true, -1); // любой свободный порт, только loopback
    this.socket.asyncListen(this);
  }

  get url() {
    return `http://127.0.0.1:${this.socket.port}/mcp`;
  }

  stop() {
    try {
      this.socket.close();
    } catch (e) {}
  }

  onStopListening() {}

  // Соединение держим открытым (keep-alive): Claude Code переиспользует
  // соединения, и каждое закрытие с нашей стороны считает обрывом — после
  // трёх таких отключает сервер. Запросы на одном соединении — по очереди.
  onSocketAccepted(server, transport) {
    const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    const output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
    const reader = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    reader.setInputStream(input);
    let buffer = new Uint8Array(0);
    let busy = false;
    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        input.close();
        output.close();
        transport.close(Cr.NS_OK);
      } catch (e) {}
    };
    const wait = () => !closed && input.asyncWait(onReady, 0, 0, Services.tm.mainThread);
    const next = async () => {
      if (busy || closed) {
        return;
      }
      const request = parseRequest(buffer);
      if (!request) {
        wait();
        return;
      }
      busy = true;
      buffer = buffer.slice(request.size);
      const response = await this.respond(request).catch(e => {
        console.error("kit-ai mcp:", e);
        return { status: 500, body: String(e) };
      });
      try {
        writeResponse(output, response, request.headers.connection === "close");
      } catch (e) {
        close();
        return;
      }
      busy = false;
      if (request.headers.connection === "close") {
        close();
      } else {
        next();
      }
    };
    const onReady = {
      onInputStreamReady: () => {
        let available;
        try {
          available = input.available();
        } catch (e) {
          close(); // клиент закрыл соединение
          return;
        }
        if (available > 0) {
          const chunk = new Uint8Array(reader.readByteArray(available));
          const merged = new Uint8Array(buffer.length + chunk.length);
          merged.set(buffer);
          merged.set(chunk, buffer.length);
          buffer = merged;
        }
        if (busy) {
          wait(); // следующий запрос дочитаем и обработаем после текущего
        } else {
          next();
        }
      },
    };
    wait();
  }

  async respond(request) {
    if (!request.path.startsWith("/mcp")) {
      return { status: 404, body: "" };
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      return { status: 403, body: "" };
    }
    if (request.method === "DELETE") {
      return { status: 200, body: "" };
    }
    if (request.method !== "POST") {
      return { status: 405, body: "", headers: { Allow: "POST" } };
    }
    const message = JSON.parse(decoder.decode(request.body));
    if (Array.isArray(message)) {
      const results = (await Promise.all(message.map(m => this.rpc(m)))).filter(Boolean);
      return results.length ? { status: 200, json: results } : { status: 202, body: "" };
    }
    const result = await this.rpc(message);
    return result ? { status: 200, json: result } : { status: 202, body: "" };
  }

  async rpc(message) {
    const { id, method, params } = message;
    if (id === undefined || id === null) {
      return null; // уведомление (notifications/initialized и т.п.)
    }
    const reply = result => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "zen", version: "1.0.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: this.tools });
      case "tools/call":
        try {
          const content = await this.onCall(params.name, params.arguments || {});
          return reply({ content });
        } catch (e) {
          return reply({ content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });
        }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } };
  }
}

function indexOfHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function parseRequest(bytes) {
  const end = indexOfHeaderEnd(bytes);
  if (end < 0) {
    return null;
  }
  const lines = decoder.decode(bytes.subarray(0, end)).split("\r\n");
  const [method, path] = lines[0].split(" ");
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) {
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  const length = parseInt(headers["content-length"] || "0", 10);
  const body = bytes.subarray(end + 4);
  if (body.length < length) {
    return null;
  }
  return { method, path, headers, body: body.subarray(0, length), size: end + 4 + length };
}

const STATUS_TEXT = { 200: "OK", 202: "Accepted", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error" };

function writeResponse(out, { status, json, body = "", headers = {} }, closing) {
  const payload = encoder.encode(json === undefined ? body : JSON.stringify(json));
  const head = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] || ""}`,
    `Content-Type: ${json === undefined ? "text/plain" : "application/json"}; charset=utf-8`,
    `Content-Length: ${payload.length}`,
    `Connection: ${closing ? "close" : "keep-alive"}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ].join("\r\n");
  const writer = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
  writer.setOutputStream(out);
  writer.writeByteArray(encoder.encode(head));
  writer.writeByteArray(payload);
  out.flush();
}

// ---- Процесс Claude Code ----

// Один процесс на разговор: сообщения уходят в stdin построчно (stream-json),
// события приходят из stdout. Если процесс завершился (стоп, ошибка),
// следующее сообщение поднимет новый с --resume и тем же разговором.
class ClaudeSession {
  constructor({ args, onEvent, onExit }) {
    this.args = args; // () → string[] — аргументы без --resume
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.sessionId = null;
    this.proc = null;
    this.killed = new WeakSet();
  }

  get running() {
    return !!this.proc;
  }

  // content — строка или блоки сообщения (text, image)
  async send(content) {
    if (!this.proc) {
      await this.spawn();
    }
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const line = JSON.stringify({ type: "user", message: { role: "user", content: blocks } });
    await this.proc.stdin.write(encoder.encode(line + "\n"));
  }

  async spawn() {
    const command = await findClaude();
    if (!command) {
      throw new Error("Claude Code (the claude command) was not found. Install it or set the path in about:config → kit.ai.claude-path");
    }
    const repo = findRepo();
    if (!repo) {
      throw new Error("Repository not found: the profile is not linked with bin/install (or set kit.ai.repo)");
    }
    const args = await this.args();
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    const proc = await Subprocess.call({
      command,
      arguments: args,
      workdir: repo,
      environment: { PATH: searchPath(), KIT_AI: "1" },
      environmentAppend: true,
      stderr: "pipe",
    });
    this.proc = proc;
    let stderr = "";
    const readStderr = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const buf = await proc.stderr.read().catch(() => null);
        if (!buf || !buf.byteLength) {
          break;
        }
        stderr = (stderr + dec.decode(buf, { stream: true })).slice(-4000);
      }
    })();
    (async () => {
      const dec = new TextDecoder();
      let pending = "";
      for (;;) {
        const buf = await proc.stdout.read().catch(() => null);
        if (!buf || !buf.byteLength) {
          break;
        }
        pending += dec.decode(buf, { stream: true });
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line) {
            continue;
          }
          let event;
          try {
            event = JSON.parse(line);
          } catch (e) {
            continue;
          }
          if (event.session_id) {
            this.sessionId = event.session_id;
          }
          try {
            this.onEvent(event);
          } catch (e) {
            console.error("kit-ai event:", e);
          }
        }
      }
      const { exitCode } = await proc.wait();
      await readStderr;
      if (this.proc === proc) {
        this.proc = null;
      }
      this.onExit({ exitCode, stderr, killed: this.killed.has(proc) });
    })();
  }

  stop() {
    if (this.proc) {
      this.killed.add(this.proc);
      this.proc.kill();
      this.proc = null;
    }
  }
}

// Вошёл ли Claude Code в аккаунт: `claude auth status` → { loggedIn, email, … }.
// Сам вход — в терминале (`claude auth login`), он общий для всех запусков claude.
async function claudeAuth() {
  const command = await findClaude();
  if (!command) {
    return { installed: false, loggedIn: false };
  }
  const proc = await Subprocess.call({
    command,
    arguments: ["auth", "status", "--json"],
    environment: { PATH: searchPath() },
    environmentAppend: true,
    stderr: "stdout",
  });
  let out = "";
  const dec = new TextDecoder();
  for (;;) {
    const buf = await proc.stdout.read().catch(() => null);
    if (!buf || !buf.byteLength) {
      break;
    }
    out += dec.decode(buf, { stream: true });
  }
  await proc.wait();
  try {
    const status = JSON.parse(out.slice(out.indexOf("{")));
    return { installed: true, loggedIn: !!status.loggedIn, email: status.email || "", plan: status.subscriptionType || "" };
  } catch (e) {
    return { installed: true, loggedIn: false };
  }
}

export const KitAI = { findRepo, findUserDir, personalAgents, McpServer, ClaudeSession, claudeAuth };
