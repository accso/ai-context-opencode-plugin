import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicSummary,
  createDocSummaryProvider,
  createLlmSummarizer,
  createSummaryProvider,
} from "../../src/indexing/file-summary.js";

test("deterministic summary lists path, language, unique symbols and the leading comment", () => {
  const text = buildDeterministicSummary({
    relativePath: "src/user.ts",
    language: "typescript",
    symbols: ["UserService", "getUser", "UserService", undefined],
    content: "/**\n * Handles user lookups.\n */\nexport class UserService {}\n",
  });
  assert.match(text, /src\/user\.ts/);
  assert.match(text, /typescript/);
  assert.match(text, /UserService, getUser/);
  assert.equal((text.match(/UserService/g) ?? []).length, 1);
  assert.match(text, /Handles user lookups/);
});

test("deterministic summary caps the symbol list", () => {
  const symbols = Array.from({ length: 100 }, (_, i) => `sym${i}`);
  const text = buildDeterministicSummary({ relativePath: "a.ts", language: "typescript", symbols, content: "" });
  assert.match(text, /sym39/);
  assert.doesNotMatch(text, /sym40\b/);
});

test("llm summarizer posts an OpenAI chat completion with the exact model and returns the trimmed text", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const summarize = createLlmSummarizer({
    baseUrl: "http://localhost:1234/v1/",
    model: "qwen2.5-coder-7b-instruct",
    apiKey: "secret",
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "  Does X.  \n" } }] }), { status: 200 });
    }) as never,
  });
  assert.equal(await summarize({ relativePath: "a.ts", content: "code" }), "Does X.");
  assert.equal(seen!.url, "http://localhost:1234/v1/chat/completions");
  const body = JSON.parse(seen!.init.body as string);
  assert.equal(body.model, "qwen2.5-coder-7b-instruct");
  assert.match(JSON.stringify(body.messages), /a\.ts/);
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer secret");
});

test("a 401 without an API key tells the user which variable to set", async () => {
  const summarize = createLlmSummarizer({
    baseUrl: "http://x/v1",
    model: "m",
    apiKeyEnvName: "MY_KEY",
    fetch: (async () => new Response("denied", { status: 401 })) as never,
  });
  await assert.rejects(
    () => summarize({ relativePath: "a.ts", content: "c" }),
    (error: Error) => {
      assert.equal(error.name, "SummaryLlmAuthError");
      assert.match(error.message, /API key not set/);
      assert.match(error.message, /export MY_KEY=/);
      assert.match(error.message, /restart opencode/);
      return true;
    },
  );
});

test("a 401 with an API key says the key was rejected and never echoes it", async () => {
  const summarize = createLlmSummarizer({
    baseUrl: "http://x/v1",
    model: "m",
    apiKey: "topsecret",
    apiKeyEnvName: "MY_KEY",
    fetch: (async () => new Response("denied", { status: 401 })) as never,
  });
  await assert.rejects(
    () => summarize({ relativePath: "a.ts", content: "c" }),
    (error: Error) => {
      assert.match(error.message, /rejected/);
      assert.match(error.message, /export MY_KEY=/);
      assert.doesNotMatch(error.message, /topsecret/);
      return true;
    },
  );
});

test("llm summarizer throws on HTTP errors and empty answers", async () => {
  const bad = createLlmSummarizer({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: (async () => new Response("nope", { status: 500 })) as never,
  });
  await assert.rejects(() => bad({ relativePath: "a.ts", content: "c" }), /500/);
  const empty = createLlmSummarizer({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }))) as never,
  });
  await assert.rejects(() => empty({ relativePath: "a.ts", content: "c" }), /empty/);
});

test("summary provider falls back to the deterministic text when the llm fails", async () => {
  const problems: unknown[] = [];
  const provide = createSummaryProvider({
    llm: async () => {
      throw new Error("down");
    },
    onProblem: (e) => problems.push(e),
  });
  const text = await provide({ relativePath: "a.ts", language: "typescript", symbols: ["foo"], content: "x" });
  assert.deepEqual(text, { text: "File a.ts (typescript). Defines: foo.", fallback: true });
  assert.equal(problems.length, 1);
});

test("summary provider stops calling a failing llm after three consecutive failures", async () => {
  let calls = 0;
  const provide = createSummaryProvider({
    llm: async () => {
      calls++;
      throw new Error("down");
    },
  });
  for (let i = 0; i < 6; i++) await provide({ relativePath: "a.ts", language: "text", symbols: [], content: "" });
  assert.equal(calls, 3);
});

test("summary provider uses the llm answer and resets the failure count on success", async () => {
  let n = 0;
  const provide = createSummaryProvider({
    llm: async () => {
      n++;
      if (n === 1) throw new Error("blip");
      return "LLM text";
    },
  });
  await provide({ relativePath: "a.ts", language: "text", symbols: [], content: "" });
  assert.equal(await provide({ relativePath: "a.ts", language: "text", symbols: [], content: "" }), "LLM text");
});

test("summary provider without llm is purely deterministic", async () => {
  const provide = createSummaryProvider({});
  const text = await provide({ relativePath: "a.ts", language: "text", symbols: ["z"], content: "" });
  assert.equal(typeof text, "string");
  assert.match(text as string, /z/);
});

test("doc summary provider returns the llm text and prompts for documents, not code", async () => {
  let body: { messages: { content: string }[] } | undefined;
  const llm = createLlmSummarizer({
    baseUrl: "http://x/v1",
    model: "m",
    systemPrompt: "You summarize documentation sections.",
    fetch: (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "About retries." } }] }));
    }) as never,
  });
  const provider = createDocSummaryProvider({ llm });
  assert.equal(await provider("# Retries\nWe retry.", "node"), "About retries.");
  assert.match(body!.messages[0]!.content, /documentation/);
  assert.match(body!.messages[1]!.content, /We retry/);
});

test("doc summary provider returns null on failure and stops calling the llm after three failures", async () => {
  let calls = 0;
  const problems: unknown[] = [];
  const provider = createDocSummaryProvider({
    llm: async () => {
      calls++;
      throw new Error("down");
    },
    onProblem: (e) => problems.push(e),
  });
  for (let i = 0; i < 5; i++) assert.equal(await provider("text", "node"), null);
  assert.equal(calls, 3);
  assert.equal(problems.length, 3);
});

import { looksLikeToolCall } from "../../src/indexing/file-summary.js";

test("looksLikeToolCall detects JSON tool calls but not prose or ordinary JSON", () => {
  assert.equal(looksLikeToolCall('```json\n{"name": "glossary__get_terms", "arguments": {}}\n```'), true);
  assert.equal(looksLikeToolCall('{"name": "context7__resolve-library-id", "arguments": {"query": "x"}}'), true);
  assert.equal(looksLikeToolCall('{"name": "x", "arguments": {}}'), true);
  assert.equal(looksLikeToolCall("The file defines a name and arguments parser."), false);
  assert.equal(looksLikeToolCall('{"version": 1}'), false);
});

test("llm summarizer sends tool_choice none and rejects a tool-call answer", async () => {
  let body: Record<string, unknown> = {};
  const summarize = createLlmSummarizer({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '```json\n{"name": "a__b", "arguments": {}}\n```' } }] }),
        { status: 200 },
      );
    }) as never,
  });
  await assert.rejects(() => summarize({ relativePath: "a.md", content: "c" }), /tool call/);
  assert.equal(body.tool_choice, "none");
});

test("llm summarizer retries once without tool_choice when the server answers 400 and remembers it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const summarize = createLlmSummarizer({
    baseUrl: "http://x/v1",
    model: "m",
    fetch: (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      bodies.push(b);
      if ("tool_choice" in b) return new Response("bad", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Fine." } }] }), { status: 200 });
    }) as never,
  });
  assert.equal(await summarize({ relativePath: "a.ts", content: "c" }), "Fine.");
  assert.equal(await summarize({ relativePath: "b.ts", content: "c" }), "Fine.");
  assert.equal(bodies.length, 3); // 400, retry, then the second call goes straight without tool_choice
  assert.equal("tool_choice" in bodies[2]!, false);
});
