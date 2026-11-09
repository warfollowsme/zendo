// Tests for the in-browser agents (resources/kit-ai/api.sys.mjs, chatgpt.sys.mjs):
// what Stop, a new message and a reopened chat do to the history that goes back
// to the model. The real agent loops run here against a scripted server that
// checks every request the way the provider would.
// Run by bin/check, or directly: node tests/agents.test.mjs
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { resolve } from "./_gecko.mjs";

// let node import the assistant's browser modules (see _gecko.mjs)
if (nodeModule.registerHooks) {
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register("./_gecko.mjs", import.meta.url);
}

globalThis.Services = {
  logins: {
    searchLoginsAsync: async () => ["anthropic", "openai", "compatible"].map(username => ({ username, password: "test-key" })),
  },
  prefs: { getStringPref: (name, fallback) => (name === "kit.ai.compatible-url" ? "http://server.test/v1" : fallback) },
  uuid: { generateUUID: () => ({ toString: () => "{00000000-0000-0000-0000-000000000000}" }) },
};

const { AnthropicAgent, OpenAIAgent, CompatibleAgent } = await import("../profile/chrome/resources/kit-ai/api.sys.mjs");

// ---------------------------------------------------------------- scripted server

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred() {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return { promise, resolve };
}

// replies: what each request gets, in order — { events, hang } (a stream of
// events; hang keeps it open until the request is aborted) or { status, error }.
// check(body) throws when the provider would reject the request.
function server(format, replies, check) {
  const requests = [];
  const frame = {
    anthropic: e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
    responses: e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
    chat: e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`,
  }[format];
  const fetch = async (url, { body, signal, headers }) => {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const request = { url, headers, body: JSON.parse(body) };
    requests.push(request);
    try {
      check(request.body);
    } catch (e) {
      request.rejected = e.message;
      return new Response(JSON.stringify({ error: { message: e.message } }), { status: 400 });
    }
    const reply = replies.shift();
    assert.ok(reply, `unexpected request #${requests.length}: a loop that should have ended is still running`);
    if (reply.status) {
      return new Response(JSON.stringify({ error: { message: reply.error } }), { status: reply.status });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of reply.events) {
          controller.enqueue(encoder.encode(frame(event)));
        }
        if (reply.hang) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted.", "AbortError")));
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, { status: 200 });
  };
  return { requests, win: { fetch, AbortController }, left: () => replies.length };
}

// A tool whose result the test releases by hand, and a UI that only records.
function harness() {
  const tool = { called: deferred(), result: deferred(), calls: 0 };
  const seen = [];
  return {
    tool,
    seen,
    callTool: async () => {
      tool.calls++;
      tool.called.resolve();
      return tool.result.promise;
    },
    ui: {
      textStart: () => seen.push("textStart"),
      textDelta: chunk => seen.push(chunk),
      textEnd: () => seen.push("textEnd"),
      tool: () => seen.push("tool"),
      toolDone: () => seen.push("toolDone"),
      status: value => seen.push(`status:${value}`),
    },
  };
}
const TOOLS = [{ name: "get_page", description: "Read the page", parameters: { type: "object", properties: {} } }];
const until = async condition => {
  for (let i = 0; i < 200 && !condition(); i++) {
    await tick();
  }
  assert.ok(condition(), "timed out waiting");
};

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${String(e.message).split("\n").join("\n  ")}`);
  }
}

// ---------------------------------------------------------------- Anthropic

// The Messages API rules a history can break.
function checkAnthropic(body) {
  const { messages } = body;
  assert.equal(messages[0]?.role, "user", "the first message is the user's");
  assert.equal(messages.at(-1).role, "user", "the last message is the user's");
  let open = new Set();
  messages.forEach((message, i) => {
    assert.ok(Array.isArray(message.content) && message.content.length, `messages.${i}: empty content`);
    if (message.role === "assistant") {
      assert.equal(open.size, 0, `messages.${i}: tool_use ids without tool_result: ${[...open]}`);
      assert.notEqual(messages[i - 1]?.role, "assistant", `messages.${i}: two assistant messages in a row`);
      for (const block of message.content) {
        if (block.type === "thinking") {
          assert.ok(block.signature, `messages.${i}: Invalid \`signature\` in \`thinking\` block`);
        }
        if (block.type === "text") {
          assert.ok(block.text, `messages.${i}: text content blocks must be non-empty`);
        }
        if (block.type === "tool_use") {
          open.add(block.id);
        }
      }
    } else {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          assert.ok(open.delete(block.tool_use_id), `messages.${i}: unexpected tool_use_id in tool_result: ${block.tool_use_id}`);
        }
      }
      assert.equal(open.size, 0, `messages.${i}: tool_use ids without tool_result: ${[...open]}`);
    }
  });
}

const A = {
  start: { type: "message_start", message: { id: "msg", role: "assistant", content: [] } },
  thinking: index => [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "Let me look." } },
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "SIGNED" } },
    { type: "content_block_stop", index },
  ],
  text: (index, text) => [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index },
  ],
  toolUse: (index, id) => [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "get_page", input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index },
  ],
  end: stop_reason => [{ type: "message_delta", delta: { stop_reason } }, { type: "message_stop" }],
};
const anthropicTool = id => ({ events: [A.start, ...A.thinking(0), ...A.toolUse(1, id), ...A.end("tool_use")] });
const anthropicText = text => ({ events: [A.start, ...A.text(0, text), ...A.end("end_turn")] });

function anthropic(replies, options = {}) {
  const fake = server("anthropic", replies, checkAnthropic);
  const h = harness();
  const agent = new AnthropicAgent({ win: fake.win, instructions: "Be brief.", tools: TOOLS, callTool: h.callTool, ui: h.ui, model: "claude-opus-5-5", ...options });
  return { agent, fake, ...h };
}

await check("Anthropic: Stop during a tool, then a new message — one loop, a valid history", async () => {
  const { agent, fake, tool } = anthropic([anthropicTool("toolu_1"), anthropicText("Second answer.")]);
  const first = agent.send("first");
  await tool.called.promise;
  agent.stop();
  await agent.send("second"); // the user doesn't wait for the old tool
  tool.result.resolve([{ type: "text", text: "late page text" }]); // …which finishes now
  await first;
  await tick();
  assert.equal(fake.requests.length, 2, "the stopped turn asked the model again");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
  checkAnthropic({ messages: [...agent.history, { role: "user", content: [{ type: "text", text: "next" }] }] });
  assert.equal(agent.history.at(-1).content[0].text, "Second answer.");
});

await check("Anthropic: Stop while thinking leaves no unsigned block", async () => {
  const hanging = {
    events: [
      A.start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } },
    ],
    hang: true,
  };
  const { agent, fake, seen } = anthropic([hanging, anthropicText("Fine.")]);
  const first = agent.send("first");
  await until(() => seen.includes("status:thinking…"));
  agent.stop();
  await first;
  await agent.send("second");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
  assert.equal(JSON.stringify(agent.history).includes('"thinking"'), false);
});

await check("Anthropic: Stop mid-sentence keeps the text the user saw, nothing half-made", async () => {
  const hanging = {
    events: [
      A.start,
      ...A.thinking(0),
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The page says" } },
    ],
    hang: true,
  };
  const { agent, fake, seen } = anthropic([hanging, anthropicText("Fine.")]);
  const first = agent.send("first");
  await until(() => seen.includes("The page says"));
  agent.stop();
  await first;
  assert.deepEqual(agent.history.at(-1), { role: "assistant", content: [{ type: "text", text: "The page says" }] });
  await agent.send("second");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
});

await check("Anthropic: Stop right after the text block opened stores nothing empty", async () => {
  const hanging = { events: [A.start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }], hang: true };
  const { agent, fake, seen } = anthropic([hanging, anthropicText("Fine.")]);
  const first = agent.send("first");
  await until(() => seen.includes("textStart"));
  agent.stop();
  await first;
  await agent.send("second");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
});

await check("Anthropic: after a fallback, the declined attempt's thinking and calls are not echoed or run", async () => {
  const reply = {
    events: [
      A.start,
      ...A.thinking(0),
      ...A.toolUse(1, "toolu_declined"),
      { type: "content_block_start", index: 2, content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } } },
      { type: "content_block_stop", index: 2 },
      ...A.text(3, "Answer from the fallback model."),
      ...A.end("end_turn"),
    ],
  };
  const { agent, tool } = anthropic([reply]);
  await agent.send("first");
  assert.equal(tool.calls, 0);
  assert.deepEqual(agent.history.at(-1).content.map(b => b.type), ["fallback", "text"]);
});

// ---------------------------------------------------------------- OpenAI (Responses API)

// function_call ↔ function_call_output pairing; a reasoning item needs the item it led to.
function checkResponses(body) {
  const items = body.input;
  const calls = new Map();
  items.forEach((item, i) => {
    if (item.type === "function_call") {
      calls.set(item.call_id, 0);
    } else if (item.type === "function_call_output") {
      assert.ok(calls.has(item.call_id), `input.${i}: no function_call for ${item.call_id}`);
      calls.set(item.call_id, calls.get(item.call_id) + 1);
    } else if (item.type === "reasoning") {
      assert.ok(["message", "function_call"].includes(items[i + 1]?.type), `input.${i}: reasoning item without its following item`);
    }
  });
  for (const [id, outputs] of calls) {
    assert.equal(outputs, 1, `function_call ${id} has ${outputs} outputs`);
  }
}
const R = {
  reasoning: { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "x", summary: [] } },
  call: id => ({ type: "response.output_item.done", item: { type: "function_call", id: `fc_${id}`, call_id: id, name: "get_page", arguments: "{}" } }),
  message: text => [
    { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text }] } },
  ],
  completed: { type: "response.completed", response: { output: [] } },
};

function openai(replies) {
  const fake = server("responses", replies, checkResponses);
  const h = harness();
  const agent = new OpenAIAgent({ win: fake.win, instructions: "Be brief.", tools: TOOLS, callTool: h.callTool, ui: h.ui, model: "gpt-test" });
  return { agent, fake, ...h };
}

await check("OpenAI: Stop during a tool, then a new message — one loop, a valid history", async () => {
  const { agent, fake, tool } = openai([
    { events: [R.reasoning, R.call("call_1"), R.completed] },
    { events: [...R.message("Second answer."), R.completed] },
  ]);
  const first = agent.send("first");
  await tool.called.promise;
  agent.stop();
  await agent.send("second");
  tool.result.resolve([{ type: "text", text: "late page text" }]);
  await first;
  await tick();
  assert.equal(fake.requests.length, 2, "the stopped turn asked the model again");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
  checkResponses({ input: agent.history });
});

await check("OpenAI: Stop mid-reply leaves no reasoning item without its message", async () => {
  const hanging = { events: [R.reasoning, { type: "response.output_item.added", item: { type: "message", id: "msg_1" } }, { type: "response.output_text.delta", delta: "The page" }], hang: true };
  const { agent, fake, seen } = openai([hanging, { events: [...R.message("Fine."), R.completed] }]);
  const first = agent.send("first");
  await until(() => seen.includes("The page"));
  agent.stop();
  await first;
  await agent.send("second");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
  checkResponses({ input: agent.history });
});

// ---------------------------------------------------------------- OpenAI-compatible (Chat Completions)

function checkChat(body) {
  const messages = body.messages.slice(1); // without the system message
  let open = new Set();
  messages.forEach((message, i) => {
    if (message.role === "tool") {
      assert.ok(open.delete(message.tool_call_id), `messages.${i}: tool message without its call: ${message.tool_call_id}`);
      return;
    }
    assert.equal(open.size, 0, `messages.${i}: tool calls without a tool message: ${[...open]}`);
    if (message.role === "assistant") {
      assert.ok(message.content || message.tool_calls?.length, `messages.${i}: empty assistant message`);
      open = new Set((message.tool_calls || []).map(call => call.id));
    }
  });
  assert.equal(open.size, 0, `tool calls without a tool message: ${[...open]}`);
}
const C = {
  call: id => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "get_page", arguments: "{}" } }] } }] }),
  text: content => ({ choices: [{ delta: { content } }] }),
  finish: finish_reason => ({ choices: [{ delta: {}, finish_reason }] }),
};

function compatible(replies) {
  const fake = server("chat", replies, checkChat);
  const h = harness();
  const agent = new CompatibleAgent({ win: fake.win, instructions: "Be brief.", tools: TOOLS, callTool: h.callTool, ui: h.ui, model: "local-test" });
  return { agent, fake, ...h };
}

await check("OpenAI-compatible: Stop during a tool, then a new message — one loop, a valid history", async () => {
  const { agent, fake, tool } = compatible([
    { events: [C.call("call_1"), C.finish("tool_calls"), "[DONE]"] },
    { events: [C.text("Second answer."), C.finish("stop"), "[DONE]"] },
  ]);
  const first = agent.send("first");
  await tool.called.promise;
  agent.stop();
  await agent.send("second");
  tool.result.resolve([{ type: "text", text: "late page text" }]);
  await first;
  await tick();
  assert.equal(fake.requests.length, 2, "the stopped turn asked the model again");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
  checkChat({ messages: [{ role: "system" }, ...agent.history] });
});

await check("OpenAI-compatible: Stop mid-reply keeps the text, not a half-made tool call", async () => {
  const hanging = { events: [C.text("The page"), { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "get_page", arguments: '{"ta' } }] } }] }], hang: true };
  const { agent, fake, seen } = compatible([hanging, { events: [C.text("Fine."), C.finish("stop"), "[DONE]"] }]);
  const first = agent.send("first");
  await until(() => seen.includes("The page"));
  agent.stop();
  await first;
  assert.deepEqual(agent.history.at(-1), { role: "assistant", content: "The page" });
  await agent.send("second");
  assert.deepEqual(fake.requests.map(r => r.rejected), [undefined, undefined]);
});

// ---------------------------------------------------------------- every agent

for (const [name, make, reply] of [
  ["Anthropic", anthropic, { events: [A.start], hang: true }],
  ["OpenAI", openai, { events: [], hang: true }],
  ["OpenAI-compatible", compatible, { events: [], hang: true }],
]) {
  await check(`${name}: a stop passes its signal to the tool that is running`, async () => {
    const fake = server(name === "Anthropic" ? "anthropic" : name === "OpenAI" ? "responses" : "chat", [
      name === "Anthropic" ? anthropicTool("toolu_1") : name === "OpenAI" ? { events: [R.call("call_1"), R.completed] } : { events: [C.call("call_1"), C.finish("tool_calls"), "[DONE]"] },
    ], () => {});
    const h = harness();
    let signal;
    const Agent = { Anthropic: AnthropicAgent, OpenAI: OpenAIAgent, "OpenAI-compatible": CompatibleAgent }[name];
    const agent = new Agent({
      win: fake.win,
      instructions: "",
      tools: TOOLS,
      ui: h.ui,
      model: "claude-opus-4-8",
      callTool: (toolName, args, options) => {
        signal = options?.signal;
        h.tool.called.resolve();
        return h.tool.result.promise;
      },
    });
    const first = agent.send("first");
    await h.tool.called.promise;
    assert.equal(signal?.aborted, false);
    agent.stop();
    assert.equal(signal.aborted, true, "the tool isn't told to stop");
    h.tool.result.resolve([{ type: "text", text: "late" }]);
    await first;
  });
  void make;
  void reply;
}

if (failed) {
  console.error(`agent tests: ${failed} failed`);
  process.exit(1);
}
console.log("agent tests passed");
