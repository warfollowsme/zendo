// ИИ-помощник: подключение по API-ключу — Anthropic (Claude) или OpenAI.
// Импортируется из JS/kit-ai.uc.js как chrome://userchrome/content/kit-ai/api.sys.mjs.
//
// Ключ хранится в менеджере паролей (about:logins → chrome://kit-ai, «API»),
// зашифрованным. Запросы идут напрямую на api.anthropic.com / api.openai.com
// и оплачиваются по тарифу API, а не подписки.

import { ChatGPTAgent } from "chrome://userchrome/content/kit-ai/chatgpt.sys.mjs";

const LOGIN_ORIGIN = "chrome://kit-ai";
const LOGIN_REALM = "API";
const MAX_STEPS = 60;
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export const API_PROVIDERS = {
  anthropic: { name: "Anthropic API", url: "https://api.anthropic.com/v1", defaultModel: "claude-opus-5-5" },
  openai: { name: "OpenAI API", url: "https://api.openai.com/v1", defaultModel: "" },
};

// Anthropic: ключи начинаются с sk-ant-, остальные sk-… — OpenAI.
export function guessProvider(key) {
  return /^sk-ant-/.test(key.trim()) ? "anthropic" : "openai";
}

// ---------------------------------------------------------------- ключи

async function findLogins(provider) {
  const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: LOGIN_REALM });
  return provider ? logins.filter(l => l.username === provider) : logins;
}

export async function connected() {
  return (await findLogins()).map(l => l.username).filter(p => API_PROVIDERS[p]);
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
}

function headers(provider, key) {
  if (provider === "anthropic") {
    return {
      "x-api-key": key,
      "anthropic-version": "2026-10-21",
      // запрос идёт из браузера: без этого заголовка API отклоняет запросы с Origin
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

// ---------------------------------------------------------------- модели

const cachedModels = {};

// Список моделей ключа; заодно проверяет, что ключ рабочий (бросает ошибку, если нет).
export async function models(win, provider, key) {
  if (!key && cachedModels[provider]) {
    return cachedModels[provider];
  }
  const response = await win.fetch(`${API_PROVIDERS[provider].url}/models?limit=200`, {
    headers: headers(provider, key || (await apiKey(provider))),
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`${API_PROVIDERS[provider].name} (${response.status}): ${await errorText(response)}`);
  }
  const json = await response.json();
  let list = (json.data || []).map(m => ({ id: m.id, name: m.display_name || m.id, created: m.created_at || m.created || 0 }));
  if (provider === "openai") {
    // только чатовые модели: без эмбеддингов, озвучки, картинок и т.п.
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

// Тот же Responses API, что у ChatGPT по подписке, — другой адрес и ключ.
export class OpenAIAgent extends ChatGPTAgent {
  label = "OpenAI API";

  async endpoint() {
    return { url: `${API_PROVIDERS.openai.url}/responses`, headers: headers("openai", await apiKey("openai")) };
  }
}

// ---------------------------------------------------------------- Anthropic

// Цикл Messages API: ответ модели (поток) → вызовы инструментов → их
// результаты одним сообщением → … Тот же интерфейс, что у ChatGPTAgent.
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

  // На каждый tool_use в истории нужен tool_result в следующем сообщении,
  // иначе запрос отклонят. После остановки посреди хода дописываем недостающие.
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

  // content — строка или готовые блоки (text, image, document)
  async send(content) {
    this.stopped = false;
    this.repairHistory();
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const last = this.history.at(-1);
    if (last?.role === "user") {
      last.content.push(...blocks); // после прерванного хода — к тем же tool_result
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
    // Новые модели могут отклонить запрос фильтром безопасности (stop_reason
    // "refusal"); с fallbacks API сам повторяет его на подходящей модели.
    // Блоки "fallback" из ответа уходят обратно в историю вместе с остальными.
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

  // Один ответ модели. Блоки ответа (текст, рассуждения, вызовы) копятся как
  // пришли и целиком уходят в историю — рассуждения надо возвращать без изменений.
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
    // badInput — только наша пометка, в историю не идёт
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
      // вызов мог оборваться посередине — не выполняем его
      for (const call of calls) {
        call.badInput = true;
      }
    }
    return calls;
  }
}
