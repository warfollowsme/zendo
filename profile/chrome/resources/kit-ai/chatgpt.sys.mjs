// AI assistant: ChatGPT by subscription — sign in with a ChatGPT account, no API key
// and no Codex CLI. Runs in the browser process (imported from
// JS/kit-ai.uc.js as chrome://userchrome/content/kit-ai/chatgpt.sys.mjs).
//
// Sign-in uses the same OAuth as the official Codex: the OpenAI sign-in page
// opens in a tab, the browser intercepts the redirect to
// http://localhost:1455/auth/callback and takes the code. The token is stored
// encrypted in the password manager (about:logins → chrome://kit-ai).
// Requests go to chatgpt.com/backend-api/codex — an unofficial path for
// third-party apps: OpenAI may change it.

import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex's public OAuth client
const AUTH_URL = "https://auth.openai.com";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const API_URL = "https://chatgpt.com/backend-api/codex";
const CLIENT_VERSION = "0.163.0";
const LOGIN_ORIGIN = "chrome://kit-ai";
const LOGIN_REALM = "ChatGPT";
const FALLBACK_MODEL = "gpt-6.1-sol";
const MAX_STEPS = 60;

// ---------------------------------------------------------------- sign-in

function base64url(bytes) {
  let s = "";
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwt(token) {
  try {
    let part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    part += "=".repeat((4 - (part.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(part), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return null;
  }
}

let cachedAuth; // undefined — not read yet, null — not signed in

async function loadAuth() {
  if (cachedAuth !== undefined) {
    return cachedAuth;
  }
  const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: LOGIN_REALM });
  try {
    cachedAuth = logins.length ? JSON.parse(logins[0].password) : null;
  } catch (e) {
    cachedAuth = null;
  }
  return cachedAuth;
}

async function saveAuth(auth) {
  for (const old of await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: LOGIN_REALM })) {
    await Services.logins.removeLoginAsync(old);
  }
  if (auth) {
    const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    info.init(LOGIN_ORIGIN, null, LOGIN_REALM, auth.email || "chatgpt", JSON.stringify(auth), "", "");
    await Services.logins.addLoginAsync(info);
  }
  cachedAuth = auth;
}

function authFromTokens(json, previous) {
  const access = json.access_token;
  const claims = decodeJwt(access)?.["https://api.openai.com/auth"] || {};
  const idClaims = json.id_token ? decodeJwt(json.id_token) : null;
  const accountId = claims.chatgpt_account_id || previous?.accountId;
  if (!access || !accountId) {
    throw new Error("OpenAI returned no token or ChatGPT account id");
  }
  return {
    access,
    refresh: json.refresh_token || previous?.refresh,
    expires: Date.now() + (json.expires_in || 3600) * 1000,
    accountId,
    email: idClaims?.email || previous?.email || "",
    plan: claims.chatgpt_plan_type || previous?.plan || "",
  };
}

async function tokenRequest(win, params) {
  const response = await win.fetch(`${AUTH_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`ChatGPT sign-in failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

// Opens sign-in in a new tab (openTab(url) → tab) and waits for OpenAI to
// redirect to localhost:1455 with the code. We don't listen on the port — the
// request is intercepted and cancelled before it is sent.
export async function login(win, openTab) {
  const verifier = base64url(win.crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await win.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  );
  const state = base64url(win.crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(`${AUTH_URL}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "zen_kit_ai",
  })) {
    url.searchParams.set(k, v);
  }

  const tab = openTab(url.toString());
  const code = await new Promise((resolve, reject) => {
    const timer = win.setTimeout(() => finish(null, new Error("Sign-in was not completed within 10 minutes")), 10 * 60 * 1000);
    const observer = {
      observe(subject) {
        let channel;
        try {
          channel = subject.QueryInterface(Ci.nsIHttpChannel);
        } catch (e) {
          return;
        }
        const uri = channel.URI;
        if (uri.host !== "localhost" || uri.port !== 1455 || uri.filePath !== "/auth/callback") {
          return;
        }
        channel.cancel(Cr.NS_BINDING_ABORTED);
        const params = new URLSearchParams(uri.query);
        if (params.get("state") !== state) {
          finish(null, new Error("Sign-in response does not match the request (state)"));
        } else if (params.get("error")) {
          finish(null, new Error(params.get("error_description") || params.get("error")));
        } else {
          finish(params.get("code"));
        }
      },
    };
    const onClose = () => finish(null, new Error("The sign-in tab was closed"));
    function finish(value, error) {
      win.clearTimeout(timer);
      Services.obs.removeObserver(observer, "http-on-modify-request");
      tab?.removeEventListener("TabClose", onClose);
      error ? reject(error) : resolve(value);
    }
    Services.obs.addObserver(observer, "http-on-modify-request");
    tab?.addEventListener("TabClose", onClose);
  });
  if (tab?.isConnected) {
    win.gBrowser.removeTab(tab);
  }

  const json = await tokenRequest(win, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  const auth = authFromTokens(json);
  await saveAuth(auth);
  return auth;
}

export async function logout() {
  await saveAuth(null);
}

export async function account() {
  return loadAuth();
}

async function freshAuth(win, force = false) {
  const auth = await loadAuth();
  if (!auth) {
    throw new Error("Not signed in to ChatGPT");
  }
  if (!force && auth.expires - Date.now() > 60 * 1000) {
    return auth;
  }
  const json = await tokenRequest(win, { grant_type: "refresh_token", refresh_token: auth.refresh });
  const next = authFromTokens(json, auth);
  await saveAuth(next);
  return next;
}

function apiHeaders(auth, sessionId) {
  return {
    Authorization: `Bearer ${auth.access}`,
    "chatgpt-account-id": auth.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "zen_kit_ai",
    "session-id": sessionId,
    accept: "text/event-stream",
    "content-type": "application/json",
  };
}

// Models available with the subscription: the same list Codex shows.
let cachedModels = null;
export async function models(win) {
  if (cachedModels) {
    return cachedModels;
  }
  try {
    const auth = await freshAuth(win);
    const response = await win.fetch(`${API_URL}/models?client_version=${CLIENT_VERSION}`, {
      headers: { Authorization: `Bearer ${auth.access}`, "chatgpt-account-id": auth.accountId },
      credentials: "omit",
    });
    const json = await response.json();
    const list = (json.models || [])
      .filter(m => m.slug && (m.visibility || "list") === "list")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map(m => ({ id: m.slug, name: m.display_name || m.slug }));
    if (list.length) {
      cachedModels = list;
      return list;
    }
  } catch (e) {
    console.warn("kit-ai: ChatGPT model list is unavailable", e);
  }
  return [{ id: FALLBACK_MODEL, name: FALLBACK_MODEL }];
}

// ---------------------------------------------------------------- files and commands

// Claude Code has its own file tools; ChatGPT gets these.
export const REPO_TOOLS = [
  {
    name: "read_file",
    description: "Read a file: path relative to the repository root, or absolute in the personal layer. Lines are numbered.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "First line (1-based)" },
        limit: { type: "integer", description: "How many lines, 400 by default" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files and folders (path relative to the repository root or absolute in the personal layer; the root by default).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, depth: { type: "integer", description: "Depth, 2 by default" } },
    },
  },
  {
    name: "search_files",
    description:
      "Search file contents (grep -rn, regular expression), e.g. selectors in zen-source/src/zen.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Where to search, the whole repository by default" },
        glob: { type: "string", description: "File name filter, e.g. *.css" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a whole file in the repository.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace old_string with new_string in a file. old_string must occur exactly once.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a bash command in the repository root (bin/check, bin/sync, bin/mod on …, git commit …, git -C <personal layer> commit …). Returns output and exit code. Commands other than bin/* and git status/diff/log/add/commit need user approval.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];

const READ_ONLY_DIRS = ["zen-source", "profile/chrome/utils", "program", ".git"];
// git -C <path> — commands in the personal layer
const SAFE_COMMAND =
  /^(bin\/(check|status)|bin\/sync( --quiet)?|bin\/(theme|mod|site)( [\w.-]+)*|git (-C [^\s;&|`$<>\\]+ )?(status|diff|log)( [^;&|`$<>\n\\]*)?|git (-C [^\s;&|`$<>\\]+ )?(add|commit) [^;&|`$<>\n\\]+|ls( [^;&|`$<>\n\\]*)?|grep [^;&|`$<>\n\\]+)$/;

export function commandNeedsApproval(command) {
  return !SAFE_COMMAND.test(String(command).trim());
}

function shellPath() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  return [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

// Personal layer (~/.config/zendo): chrome/user in the profile links to it.
function userDir() {
  const file = Services.dirsvc.get("UChrm", Ci.nsIFile);
  file.append("user");
  if (!file.isSymlink() || !file.exists()) {
    return null;
  }
  file.normalize();
  return file.path;
}

const inside = (path, root) => !!root && (path === root || path.startsWith(root + "/"));

// Path for output: relative inside the repository, absolute in the personal layer.
const shown = (repo, path) => (inside(path, repo) ? path.slice(repo.length + 1) || "." : path);

function resolvePath(repo, rel = ".", { write = false } = {}) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  // PathUtils.join doesn't accept parts containing "/" — a relative path is
  // joined with joinRelative, an absolute one is taken as is (and checked
  // below to be inside the repository or the personal layer)
  const path0 = String(rel || ".").replace(/^~(?=\/)/, Services.dirsvc.get("Home", Ci.nsIFile).path);
  file.initWithPath(path0.startsWith("/") ? path0 : PathUtils.joinRelative(repo, path0));
  file.normalize();
  const path = file.path;
  const user = userDir();
  if (inside(path, user)) {
    if (write && (path === PathUtils.join(user, ".git") || path.startsWith(PathUtils.join(user, ".git") + "/"))) {
      throw new Error(".git must not be changed directly");
    }
    return path;
  }
  if (!inside(path, repo)) {
    throw new Error("The path is outside the repository and the personal layer");
  }
  const relative = path.slice(repo.length + 1);
  if (write && READ_ONLY_DIRS.some(d => relative === d || relative.startsWith(d + "/"))) {
    throw new Error(`${relative}: this folder must not be changed (see AGENTS.md)`);
  }
  return path;
}

async function run(repo, command, args, timeoutMs = 120000) {
  const proc = await Subprocess.call({
    command,
    arguments: args,
    workdir: repo,
    environment: { PATH: shellPath(), KIT_AI: "1" },
    environmentAppend: true,
    stderr: "stdout",
  });
  let out = "";
  const decoder = new TextDecoder();
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  for (;;) {
    const buf = await proc.stdout.read().catch(() => null);
    if (!buf || !buf.byteLength) {
      break;
    }
    out += decoder.decode(buf, { stream: true });
    if (out.length > 200000) {
      proc.kill();
      break;
    }
  }
  const { exitCode } = await proc.wait();
  clearTimeout(timer);
  return { exitCode, out };
}

const clip = (s, n = 30000) => (s.length > n ? s.slice(0, n) + `\n… (truncated, ${s.length} characters total)` : s);

export async function callRepoTool(repo, name, args) {
  switch (name) {
    case "read_file": {
      const lines = (await IOUtils.readUTF8(resolvePath(repo, args.path))).split("\n");
      const from = Math.max(1, args.offset || 1);
      const to = Math.min(lines.length, from - 1 + (args.limit || 400));
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
        .join("\n");
      return clip(`${args.path}: lines ${from}–${to} of ${lines.length}\n${body}`);
    }
    case "list_files": {
      const root = resolvePath(repo, args.path || ".");
      const depth = Math.min(args.depth || 2, 5);
      const out = [];
      const walk = async (dir, level) => {
        for (const child of (await IOUtils.getChildren(dir)).sort()) {
          const base = PathUtils.filename(child);
          if (base === ".git" || base.startsWith("._") || base === ".DS_Store" || out.length >= 600) {
            continue;
          }
          const info = await IOUtils.stat(child);
          const rel = shown(repo, child);
          out.push(info.type === "directory" ? rel + "/" : rel);
          if (info.type === "directory" && level < depth && base !== "node_modules") {
            await walk(child, level + 1);
          }
        }
      };
      await walk(root, 1);
      return out.join("\n") || "(empty)";
    }
    case "search_files": {
      const grepArgs = ["-rnIE", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude=._*"];
      if (args.glob) {
        grepArgs.push(`--include=${args.glob}`);
      }
      grepArgs.push("-e", args.pattern, resolvePath(repo, args.path || "."));
      const { out } = await run(repo, "/usr/bin/grep", grepArgs, 60000);
      const lines = out.split("\n").filter(Boolean).map(l => (l.startsWith(repo + "/") ? l.slice(repo.length + 1) : l));
      return clip(lines.slice(0, 200).join("\n") + (lines.length > 200 ? `\n… ${lines.length - 200} more` : "") || "Nothing found");
    }
    case "write_file": {
      const path = resolvePath(repo, args.path, { write: true });
      await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
      await IOUtils.writeUTF8(path, args.content);
      return `Written: ${args.path}`;
    }
    case "edit_file": {
      const path = resolvePath(repo, args.path, { write: true });
      const text = await IOUtils.readUTF8(path);
      const count = text.split(args.old_string).length - 1;
      if (count !== 1) {
        throw new Error(`old_string occurs ${count} time(s), exactly 1 is required`);
      }
      await IOUtils.writeUTF8(path, text.replace(args.old_string, () => args.new_string));
      return `Edited: ${args.path}`;
    }
    case "run_command": {
      const { exitCode, out } = await run(repo, "/bin/bash", ["-c", args.command]);
      return clip(`exit code: ${exitCode}\n${out}`);
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

// ---------------------------------------------------------------- agent

// Loop: request to the model → tool calls → their results back → …
// The history is kept here (store: false — nothing stays on the server).
export class ChatGPTAgent {
  // tools: [{ name, description, parameters }]
  // callTool(name, args) → Promise<content[]> in MCP format ({type:"text"} / {type:"image"})
  // ui: { textStart, textDelta, textEnd, tool(id, name, input), toolDone(id, isError), status(text) }
  label = "ChatGPT";

  constructor({ win, instructions, tools, callTool, ui, model, effort, saved }) {
    this.win = win;
    this.instructions = instructions;
    this.tools = tools;
    this.callTool = callTool;
    this.ui = ui;
    this.model = saved?.model || model;
    this.effort = effort;
    this.history = saved?.history || [];
    this.sessionId = saved?.sessionId || Services.uuid.generateUUID().toString().slice(1, -1);
    this.controller = null;
  }

  snapshot() {
    return { model: this.model, sessionId: this.sessionId, history: this.history };
  }

  stop() {
    this.stopped = true;
    this.controller?.abort();
  }

  // Every function_call in the history must have an output, or the request is rejected.
  // After a stop or error mid-turn, add the missing ones.
  repairHistory() {
    const answered = new Set(this.history.filter(i => i.type === "function_call_output").map(i => i.call_id));
    for (const item of [...this.history]) {
      if (item.type === "function_call" && !answered.has(item.call_id)) {
        this.history.push({ type: "function_call_output", call_id: item.call_id, output: "Interrupted" });
      }
    }
  }

  // content — a string or ready message parts (input_text, input_image, input_file)
  async send(content) {
    this.stopped = false;
    this.repairHistory();
    this.history.push({
      role: "user",
      content: typeof content === "string" ? [{ type: "input_text", text: content }] : content,
    });
    for (let step = 0; step < MAX_STEPS; step++) {
      const calls = await this.respond();
      if (!calls.length || this.stopped) {
        return;
      }
      for (const call of calls) {
        if (this.stopped) {
          // every function_call must have an output, or the next request is rejected
          this.history.push({ type: "function_call_output", call_id: call.call_id, output: "Stopped by the user" });
          continue;
        }
        this.history.push({ type: "function_call_output", call_id: call.call_id, output: await this.runTool(call) });
      }
      if (this.stopped) {
        return;
      }
    }
    throw new Error(`Too many steps in a row (${MAX_STEPS}) — stopped`);
  }

  async runTool(call) {
    let args = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (e) {}
    this.ui.tool(call.call_id, call.name, args);
    try {
      const content = await this.callTool(call.name, args);
      this.ui.toolDone(call.call_id, false);
      const texts = content.filter(c => c.type === "text").map(c => c.text);
      const images = content.filter(c => c.type === "image");
      if (!images.length) {
        return texts.join("\n") || "(empty)";
      }
      return [
        ...texts.map(t => ({ type: "input_text", text: t })),
        ...images.map(i => ({ type: "input_image", detail: "auto", image_url: `data:${i.mimeType};base64,${i.data}` })),
      ];
    } catch (e) {
      this.ui.toolDone(call.call_id, true);
      return `Error: ${e?.message || e}`;
    }
  }

  // Where the request goes and with which headers; OpenAIAgent (api.sys.mjs) overrides only this.
  async endpoint(force) {
    const auth = await freshAuth(this.win, force);
    return { url: `${API_URL}/responses`, headers: apiHeaders(auth, this.sessionId) };
  }

  requestBody() {
    const body = {
      model: this.model,
      instructions: this.instructions,
      input: this.history,
      tools: this.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      prompt_cache_key: this.sessionId,
    };
    if (!this.plain) {
      body.include = ["reasoning.encrypted_content"];
      body.reasoning = { summary: "auto", ...(this.effort ? { effort: this.effort } : {}) };
      body.text = { verbosity: "low" };
    }
    return body;
  }

  async request(force = false) {
    const { url, headers } = await this.endpoint(force);
    this.controller = new this.win.AbortController();
    return this.win.fetch(url, {
      method: "POST",
      headers,
      credentials: "omit",
      signal: this.controller.signal,
      body: JSON.stringify(this.requestBody()),
    });
  }

  // One model reply. Returns tool calls (empty — the turn is over).
  async respond() {
    let response;
    try {
      response = await this.request();
      if (response.status === 401) {
        response = await this.request(true);
      }
    } catch (e) {
      if (this.stopped) {
        return [];
      }
      throw e;
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 600);
      let message = body;
      try {
        const json = JSON.parse(body);
        message = json.detail || json.error?.message || json.message || body;
      } catch (e) {}
      // a model without reasoning (via API) doesn't accept reasoning/verbosity — retry without them
      if (response.status === 400 && !this.plain && /reasoning|verbosity|include/i.test(message)) {
        this.plain = true;
        return this.respond();
      }
      if (response.status === 429) {
        throw new Error(`${this.label} limit reached: ${message}`);
      }
      throw new Error(`${this.label} responded ${response.status}: ${message}`);
    }

    const calls = [];
    const byId = new Map();
    let textOpen = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = event => {
      switch (event.type) {
        case "response.output_item.added":
          if (event.item?.type === "message") {
            this.ui.textStart();
            textOpen = true;
          } else if (event.item?.type === "reasoning") {
            this.ui.status("thinking…");
          }
          break;
        case "response.output_text.delta":
          if (!textOpen) {
            this.ui.textStart();
            textOpen = true;
          }
          this.ui.textDelta(event.delta || "");
          break;
        case "response.output_item.done": {
          const item = event.item;
          if (!item) {
            break;
          }
          this.history.push(item);
          if (item.id) {
            byId.set(item.id, item);
          }
          if (item.type === "message" && textOpen) {
            this.ui.textEnd();
            textOpen = false;
          } else if (item.type === "function_call") {
            calls.push(item);
          }
          this.ui.status(this.model);
          break;
        }
        case "response.completed":
        case "response.incomplete":
          // sometimes encrypted_content arrives only in the final response
          for (const item of event.response?.output || []) {
            const stored = item.id && byId.get(item.id);
            if (stored && item.encrypted_content && !stored.encrypted_content) {
              stored.encrypted_content = item.encrypted_content;
            }
          }
          break;
        case "response.failed":
          throw new Error(event.response?.error?.message || `${this.label} could not respond`);
        case "error":
          throw new Error(event.message || event.error?.message || `${this.label} error`);
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = chunk
            .split("\n")
            .filter(l => l.startsWith("data:"))
            .map(l => l.slice(5).trim())
            .join("\n");
          if (data && data !== "[DONE]") {
            handle(JSON.parse(data));
          }
        }
        if (done) {
          break;
        }
      }
    } catch (e) {
      if (!this.stopped) {
        throw e;
      }
    } finally {
      if (textOpen) {
        this.ui.textEnd();
      }
    }
    return calls;
  }
}
