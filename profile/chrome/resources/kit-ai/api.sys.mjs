// AI assistant: connecting with an API key — Anthropic (Claude), OpenAI, or any
// OpenAI-compatible server (OpenRouter, DeepSeek, Groq, Ollama, LM Studio…).
// Imported from JS/kit-ai.uc.js as chrome://userchrome/content/kit-ai/api.sys.mjs.
//
// The key is stored encrypted in the password manager (about:logins → chrome://kit-ai, "API").
// Requests go directly to the provider and are billed at API rates, not by subscription.

import { ChatGPTAgent } from "chrome://userchrome/content/kit-ai/chatgpt.sys.mjs";

const LOGIN_ORIGIN = "chrome://kit-ai";
const LOGIN_REALM = "API";
const MAX_STEPS = 60;
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

// OpenAI-compatible: one server at a time, its address in kit.ai.compatible-url.
const PREF_COMPATIBLE_URL = "kit.ai.compatible-url";
const NO_KEY = "none"; // local servers (Ollama, LM Studio) need no key

export const COMPATIBLE_PRESETS = [
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { name: "DeepSeek", url: "https://api.deepseek.com" },
  { name: "Groq", url: "https://api.groq.com/openai/v1" },
  { name: "Ollama", url: "http://localhost:11434/v1" },
  { name: "LM Studio", url: "http://localhost:1234/v1" },
];

export function compatibleURL() {
  return Services.prefs.getStringPref(PREF_COMPATIBLE_URL, "").trim().replace(/\/+$/, "");
}

// The server's name for the UI: a preset's name or the host.
export function compatibleName(url = compatibleURL()) {
  const preset = COMPATIBLE_PRESETS.find(p => p.url === url);
  if (preset) {
    return preset.name;
  }
  try {
    return new URL(url).host;
  } catch (e) {
    return "OpenAI-compatible";
  }
}

export const API_PROVIDERS = {
  anthropic: { name: "Anthropic API", url: "https://api.anthropic.com/v1", defaultModel: "claude-opus-5-5" },
  openai: { name: "OpenAI API", url: "https://api.openai.com/v1", defaultModel: "" },
  compatible: {
    get name() {
      return compatibleName();
    },
    get url() {
      return compatibleURL();
    },
    defaultModel: "",
  },
};

// Anthropic keys start with sk-ant-, other sk-… keys are OpenAI.
export function guessProvider(key) {
  return /^sk-ant-/.test(key.trim()) ? "anthropic" : "openai";
}

// ---------------------------------------------------------------- keys

async function findLogins(provider) {
  const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: LOGIN_REALM });
  return provider ? logins.filter(l => l.username === provider) : logins;
}

export async function connected() {
  return (await findLogins())
    .map(l => l.username)
    .filter(p => API_PROVIDERS[p] && (p !== "compatible" || compatibleURL()));
}

async function apiKey(provider) {
  const [login] = await findLogins(provider);
  if (!login) {
    throw new Error(`${API_PROVIDERS[provider].name}: no API key`);
  }
  return login.password;
}

export async function saveKey(provider, key) {
  await removeKey(provider);
  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  info.init(LOGIN_ORIGIN, null, LOGIN_REALM, provider, key.trim(), "", "");
  await Services.logins.addLoginAsync(info);
  delete cachedModels[provider];
}

export async function removeKey(provider) {
  for (const login of await findLogins(provider)) {
    await Services.logins.removeLoginAsync(login);
  }
  delete cachedModels[provider];
  if (provider === "compatible") {
    Services.prefs.clearUserPref(PREF_COMPATIBLE_URL);
  }
}

// An OpenAI-compatible server: its address and key (empty — no key needed).
// The address goes after the key: saving the key removes the old one, and with it the address.
export async function saveCompatible(url, key) {
  await saveKey("compatible", key.trim() || NO_KEY);
  Services.prefs.setStringPref(PREF_COMPATIBLE_URL, url.trim().replace(/\/+$/, ""));
}

function headers(provider, key, url = compatibleURL()) {
  if (provider === "compatible") {
    const h = { "content-type": "application/json" };
    if (key && key !== NO_KEY) {
      h.Authorization = `Bearer ${key}`;
    }
    if (/openrouter\.ai/.test(url)) {
      // OpenRouter shows the app in its stats; optional
      h["HTTP-Referer"] = "https://github.com/warfollowsme/zendo";
      h["X-Title"] = "Zendo";
    }
    return h;
  }
  if (provider === "anthropic") {
    return {
      "x-api-key": key,
      "anthropic-version": "2026-10-21",
      // the request comes from a browser: without this header the API rejects requests with an Origin
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    };
  }
  return { Authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function errorText(response) {
  const body = (await response.text()).slice(0, 600);
  try {
    const json = JSON.parse(body);
    return json.error?.message || json.message || body;
  } catch (e) {
    return body;
  }
}

// ---------------------------------------------------------------- models

const cachedModels = {};

// The key's model list; also checks that the key works (throws if not).
// url — for an OpenAI-compatible server that isn't saved yet.
export async function models(win, provider, key, url) {
  if (!key && cachedModels[provider]) {
    return cachedModels[provider];
  }
  const base = (url || API_PROVIDERS[provider].url).trim().replace(/\/+$/, "");
  const name = provider === "compatible" ? compatibleName(base) : API_PROVIDERS[provider].name;
  let response;
  try {
    response = await win.fetch(`${base}/models?limit=200`, {
      headers: headers(provider, key || (await apiKey(provider)), base),
      credentials: "omit",
    });
  } catch (e) {
    throw new Error(`${name}: no answer from ${base} (${e.message || e})`);
  }
  if (!response.ok) {
    throw new Error(`${name} (${response.status}): ${await errorText(response)}`);
  }
  const json = await response.json();
  let list = (json.data || json.models || []).map(m => ({
    id: m.id,
    name: m.display_name || m.name || m.id,
    created: m.created_at || m.created || 0,
    tools: m.supported_parameters ? m.supported_parameters.includes("tools") : undefined,
    images: m.architecture?.input_modalities ? m.architecture.input_modalities.includes("image") : undefined,
    context: m.context_length,
    batch: /batch/i.test(`${m.id} ${m.name || ""}`),
    leaving: !!m.expiration_date,
  }));
  if (provider === "compatible") {
    // Hide what can't work as the assistant, when the server tells (OpenRouter does):
    // no tools (it does everything through them), a context under 128k (instructions,
    // AGENTS.md and page text alone take tens of thousands of tokens), batch
    // variants (no live replies), models about to be removed, and ones older than
    // half a year — newer generations replace them (the chosen model stays in the
    // menu anyway, see kit-ai.uc.js).
    const halfYear = Date.now() / 1000 - 183 * 86400;
    list = list
      .filter(m => m.tools !== false && !(m.context < 128000) && !m.batch && !m.leaving && !(m.created && m.created < halfYear))
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  }
  if (provider === "openai") {
    // chat models only: no embeddings, speech, images, etc.
    list = list
      .filter(m => /^(gpt-|o\d|chatgpt-)/.test(m.id))
      .filter(m => !/audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct/.test(m.id))
      .sort((a, b) => b.created - a.created);
  }
  if (!key) {
    cachedModels[provider] = list;
  }
  return list;
}

// ---------------------------------------------------------------- OpenAI

// The same Responses API as the ChatGPT subscription — different URL and key.
export class OpenAIAgent extends ChatGPTAgent {
  label = "OpenAI API";

  async endpoint() {
    return { url: `${API_PROVIDERS.openai.url}/responses`, headers: headers("openai", await apiKey("openai")) };
  }
}

// ---------------------------------------------------------------- Anthropic

// Messages API loop: model reply (stream) → tool calls → their
// results in one message → … Same interface as ChatGPTAgent.
export class AnthropicAgent {
  label = "Anthropic API";

  constructor({ win, instructions, tools, callTool, ui, model, effort, saved }) {
    this.win = win;
    this.instructions = instructions;
    this.tools = tools;
    this.callTool = callTool;
    this.ui = ui;
    this.model = saved?.model || model || API_PROVIDERS.anthropic.defaultModel;
    this.effort = effort;
    this.history = saved?.history || [];
    this.controller = null;
  }

  snapshot() {
    return { model: this.model, history: this.history };
  }

  stop() {
    this.stopped = true;
    this.controller?.abort();
  }

  // Every tool_use in the history needs a tool_result in the next message,
  // or the request is rejected. After a stop mid-turn, add the missing ones.
  repairHistory() {
    const last = this.history.at(-1);
    if (last?.role !== "assistant") {
      return;
    }
    const calls = last.content.filter(b => b.type === "tool_use");
    if (calls.length) {
      this.history.push({
        role: "user",
        content: calls.map(c => ({ type: "tool_result", tool_use_id: c.id, content: "Interrupted", is_error: true })),
      });
    }
  }

  // content — a string or ready blocks (text, image, document)
  async send(content) {
    this.stopped = false;
    this.repairHistory();
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const last = this.history.at(-1);
    if (last?.role === "user") {
      last.content.push(...blocks); // after an interrupted turn — append to the same tool_result
    } else {
      this.history.push({ role: "user", content: blocks });
    }
    for (let step = 0; step < MAX_STEPS; step++) {
      const calls = await this.respond();
      if (!calls.length || this.stopped) {
        return;
      }
      const results = [];
      for (const call of calls) {
        results.push(
          this.stopped
            ? { type: "tool_result", tool_use_id: call.id, content: "Stopped by the user", is_error: true }
            : await this.runTool(call)
        );
      }
      this.history.push({ role: "user", content: results });
      if (this.stopped) {
        return;
      }
    }
    throw new Error(`Too many steps in a row (${MAX_STEPS}) — stopped`);
  }

  async runTool(call) {
    this.ui.tool(call.id, call.name, call.input || {});
    if (call.badInput) {
      this.ui.toolDone(call.id, true);
      return { type: "tool_result", tool_use_id: call.id, content: "INVALID_JSON: the tool input was not valid JSON", is_error: true };
    }
    try {
      const content = await this.callTool(call.name, call.input || {});
      this.ui.toolDone(call.id, false);
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: content.map(c =>
          c.type === "image"
            ? { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }
            : { type: "text", text: c.text || "(empty)" }
        ),
      };
    } catch (e) {
      this.ui.toolDone(call.id, true);
      return { type: "tool_result", tool_use_id: call.id, content: `Error: ${e?.message || e}`, is_error: true };
    }
  }

  async request() {
    const body = {
      model: this.model,
      max_tokens: 64000,
      stream: true,
      system: [{ type: "text", text: this.instructions, cache_control: { type: "ephemeral" } }],
      tools: this.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        eager_input_streaming: true,
      })),
      messages: this.history,
      cache_control: { type: "ephemeral" },
    };
    if (this.effort) {
      body.output_config = { effort: this.effort };
    }
    const requestHeaders = headers("anthropic", await apiKey("anthropic"));
    // Newer models may reject a request with a safety filter (stop_reason
    // "refusal"); with fallbacks the API retries it on a suitable model itself.
    // "fallback" blocks from the response go back into the history with the rest.
    if (FALLBACK_MODELS.test(this.model)) {
      body.fallbacks = "default";
      requestHeaders["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }
    this.controller = new this.win.AbortController();
    return this.win.fetch(`${API_PROVIDERS.anthropic.url}/messages`, {
      method: "POST",
      headers: requestHeaders,
      credentials: "omit",
      signal: this.controller.signal,
      body: JSON.stringify(body),
    });
  }

  // One model reply. Response blocks (text, thinking, calls) are collected as they
  // arrive and go into the history whole — thinking must be sent back unchanged.
  async respond() {
    let response;
    try {
      response = await this.request();
    } catch (e) {
      if (this.stopped) {
        return [];
      }
      throw e;
    }
    if (!response.ok) {
      const message = await errorText(response);
      if (response.status === 429) {
        throw new Error(`${this.label} rate limit: ${message}`);
      }
      throw new Error(`${this.label} responded ${response.status}: ${message}`);
    }

    const blocks = [];
    const partialJson = [];
    let stopReason = null;
    let textOpen = false;
    const handle = event => {
      switch (event.type) {
        case "content_block_start": {
          const block = { ...event.content_block };
          blocks[event.index] = block;
          if (block.type === "text") {
            block.text = block.text || "";
            this.ui.textStart();
            textOpen = true;
            if (block.text) {
              this.ui.textDelta(block.text);
            }
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            this.ui.status("thinking…");
          } else if (block.type === "tool_use") {
            partialJson[event.index] = "";
          }
          break;
        }
        case "content_block_delta": {
          const block = blocks[event.index];
          const delta = event.delta || {};
          if (delta.type === "text_delta") {
            block.text += delta.text;
            this.ui.textDelta(delta.text);
          } else if (delta.type === "thinking_delta") {
            block.thinking = (block.thinking || "") + delta.thinking;
          } else if (delta.type === "signature_delta") {
            block.signature = (block.signature || "") + delta.signature;
          } else if (delta.type === "input_json_delta") {
            partialJson[event.index] += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks[event.index];
          if (block?.type === "text" && textOpen) {
            this.ui.textEnd();
            textOpen = false;
          } else if (block?.type === "tool_use") {
            const raw = partialJson[event.index];
            try {
              block.input = raw ? JSON.parse(raw) : block.input || {};
            } catch (e) {
              block.input = {};
              block.badInput = true;
            }
          }
          this.ui.status(this.model);
          break;
        }
        case "message_delta":
          stopReason = event.delta?.stop_reason || stopReason;
          break;
        case "error":
          throw new Error(event.error?.message || `${this.label} error`);
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
          if (data) {
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

    const content = blocks.filter(Boolean);
    const calls = content.filter(b => b.type === "tool_use");
    // badInput is only our marker, it doesn't go into the history
    const clean = content.map(({ badInput, ...b }) => b);
    if (clean.length) {
      this.history.push({ role: "assistant", content: clean });
    }
    if (this.stopped) {
      return [];
    }
    if (stopReason === "refusal") {
      throw new Error(`${this.model} declined to answer this request.`);
    }
    if (stopReason === "max_tokens" && calls.length) {
      // the call may have been cut off midway — don't run it
      for (const call of calls) {
        call.badInput = true;
      }
    }
    return calls;
  }
}

// ---------------------------------------------------------------- OpenAI-compatible

// Chat Completions loop (POST {url}/chat/completions), the format of OpenRouter,
// DeepSeek, Groq, Ollama, LM Studio…: model reply (stream) → tool calls → a
// "tool" message for each → … Same interface as ChatGPTAgent. The model must
// support tools (function calling): the assistant does everything through them.
export class CompatibleAgent {
  constructor({ win, instructions, tools, callTool, ui, model, effort, saved }) {
    this.win = win;
    this.instructions = instructions;
    this.tools = tools;
    this.callTool = callTool;
    this.ui = ui;
    this.model = saved?.model || model;
    this.effort = effort;
    this.history = saved?.history || [];
    this.controller = null;
  }

  get label() {
    return compatibleName();
  }

  snapshot() {
    return { model: this.model, history: this.history };
  }

  stop() {
    this.stopped = true;
    this.controller?.abort();
  }

  // Every tool call needs a "tool" message after it, or the next request is
  // rejected. After a stop mid-turn, add the missing ones.
  repairHistory() {
    const index = this.history.findLastIndex(m => m.role === "assistant");
    const calls = this.history[index]?.tool_calls;
    if (!calls) {
      return;
    }
    const answered = new Set(this.history.slice(index + 1).filter(m => m.role === "tool").map(m => m.tool_call_id));
    for (const call of calls) {
      if (!answered.has(call.id)) {
        this.history.push({ role: "tool", tool_call_id: call.id, content: "Interrupted" });
      }
    }
  }

  // content — a string or ready parts (text, image_url)
  async send(content) {
    this.stopped = false;
    this.repairHistory();
    this.history.push({ role: "user", content });
    for (let step = 0; step < MAX_STEPS; step++) {
      const calls = await this.respond();
      if (!calls.length || this.stopped) {
        return;
      }
      // a tool message holds text only, so images (screenshots) follow in a user message
      const images = [];
      for (const call of calls) {
        this.history.push(
          this.stopped
            ? { role: "tool", tool_call_id: call.id, content: "Stopped by the user" }
            : await this.runTool(call, images)
        );
      }
      if (images.length) {
        this.history.push({ role: "user", content: [{ type: "text", text: "Images returned by the tools above:" }, ...images] });
      }
      if (this.stopped) {
        return;
      }
    }
    throw new Error(`Too many steps in a row (${MAX_STEPS}) — stopped`);
  }

  async runTool(call, images) {
    this.ui.tool(call.id, call.name, call.input || {});
    if (call.badInput) {
      this.ui.toolDone(call.id, true);
      return { role: "tool", tool_call_id: call.id, content: "INVALID_JSON: the tool arguments were not valid JSON" };
    }
    try {
      const content = await this.callTool(call.name, call.input || {});
      this.ui.toolDone(call.id, false);
      // a text-only model (DeepSeek and many others) rejects the whole request with an image
      const vision = cachedModels.compatible?.find(m => m.id === this.model)?.images !== false;
      const texts = content.map(c => {
        if (c.type === "image") {
          if (!vision) {
            return "(an image was returned, but this model doesn't take images — use page text instead)";
          }
          images.push({ type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } });
          return "(image: see the next message)";
        }
        return c.text || "(empty)";
      });
      return { role: "tool", tool_call_id: call.id, content: texts.join("\n") };
    } catch (e) {
      this.ui.toolDone(call.id, true);
      return { role: "tool", tool_call_id: call.id, content: `Error: ${e?.message || e}` };
    }
  }

  async request(plain) {
    const body = {
      model: this.model,
      stream: true,
      messages: [{ role: "system", content: this.instructions }, ...this.history],
      tools: this.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    };
    if (this.effort && !plain) {
      body.reasoning_effort = this.effort;
    }
    const [login] = await findLogins("compatible");
    this.controller = new this.win.AbortController();
    return this.win.fetch(`${compatibleURL()}/chat/completions`, {
      method: "POST",
      headers: headers("compatible", login?.password),
      credentials: "omit",
      signal: this.controller.signal,
      body: JSON.stringify(body),
    });
  }

  // One model reply: text and tool calls arrive in pieces (deltas) and are put together.
  async respond() {
    let response;
    try {
      response = await this.request();
      if (response.status === 400 && this.effort) {
        // a model without reasoning may not accept reasoning_effort — retry without it
        const message = await errorText(response.clone());
        if (/reasoning/i.test(message)) {
          response = await this.request(true);
        }
      }
    } catch (e) {
      if (this.stopped) {
        return [];
      }
      throw e;
    }
    if (!response.ok) {
      const message = await errorText(response);
      if (response.status === 429) {
        throw new Error(`${this.label} rate limit: ${message}`);
      }
      if (/tool|function/i.test(message) && response.status < 500) {
        throw new Error(`${this.model} on ${this.label} can't call tools (function calling), and the assistant needs them — pick another model. (${message})`);
      }
      throw new Error(`${this.label} responded ${response.status}: ${message}`);
    }

    let text = "";
    let textOpen = false;
    let finish = null;
    const calls = [];
    const handle = event => {
      if (event.error) {
        throw new Error(event.error.message || `${this.label} error`);
      }
      const choice = event.choices?.[0];
      const delta = choice?.delta || {};
      if (delta.reasoning || delta.reasoning_content) {
        this.ui.status("thinking…");
      }
      if (delta.content) {
        if (!textOpen) {
          this.ui.textStart();
          textOpen = true;
        }
        text += delta.content;
        this.ui.textDelta(delta.content);
      }
      for (const piece of delta.tool_calls || []) {
        const slot = (calls[piece.index ?? calls.length] ||= { id: "", name: "", args: "" });
        slot.id ||= piece.id || "";
        slot.name += piece.function?.name || "";
        slot.args += piece.function?.arguments || "";
      }
      finish = choice?.finish_reason || finish;
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          // ": OPENROUTER PROCESSING" and other comments, empty lines between events
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data && data !== "[DONE]") {
              handle(JSON.parse(data));
            }
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
      this.ui.status(this.model);
    }

    const toolCalls = calls.filter(Boolean).map((c, i) => {
      const call = { id: c.id || `call_${Date.now()}_${i}`, name: c.name, input: {} };
      try {
        call.input = c.args ? JSON.parse(c.args) : {};
      } catch (e) {
        call.badInput = true;
      }
      // the call may have been cut off midway — don't run it
      if (finish === "length") {
        call.badInput = true;
      }
      return { call, raw: c.args || "{}" };
    });
    if (text || toolCalls.length) {
      const message = { role: "assistant", content: text || null };
      if (toolCalls.length) {
        message.tool_calls = toolCalls.map(({ call, raw }) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: raw },
        }));
      }
      this.history.push(message);
    }
    return this.stopped ? [] : toolCalls.map(t => t.call);
  }
}
