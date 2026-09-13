// One place for the chat-model client. Provider and model come from the
// environment. Two roles: "chat" (generation, agent loop) and "batch"
// (per-letter jobs: classify_letters, checkRegests, classifyPlaces).
//
// Default for both: DeepSeek V4.1 Flash (`deepseek-flash`, released
// 2026-09-10; 1M context, concurrency 2500, tools + JSON, thinking mode
// default on). Zhipu glm-5.3-flash stays available (LLM_PROVIDER=zhipu),
// but the account serialises requests (~0.8 req/s measured 2026-09-11),
// which makes it unusable for archive-wide batch jobs.
//
//   LLM_PROVIDER          chat provider: deepseek (default) | zhipu | custom
//   LLM_BATCH_PROVIDER    batch provider (default: same as LLM_PROVIDER)
//   LLM_BASE_URL / LLM_API_KEY / CHAT_MODEL   overrides (custom provider needs all)
//   LLM_THINKING          deepseek chat role: disabled (default) | low | high | max
//   LLM_REASONING         zhipu reasoning_effort (always thinks): low (default)
//
// DeepSeek thinking mode: temperature is ignored, tool loops must echo
// reasoning_content back (agent.js does). Batch jobs always run with
// thinking disabled — a label with a quote does not need it and it is
// several times faster and cheaper.

import OpenAI from "openai";

// Netways Managed AI (the academy's hosted vLLM, OpenAI-compatible, key
// NETWAYS_API_KEY): Qwen3.8-27B with thinking off answers in ~1 s and is the
// batch workhorse; openai/gpt-oss-20b (reasoning_effort low) is the second
// endpoint. Both are rate limited by the portal's Global Rate Limits — the
// batch code backs off on 429.
const PROVIDERS = {
  deepseek: { baseURL: "https://api.deepseek.com", keyVar: "DEEPSEEK_API_KEY", model: "deepseek-flash" },
  zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", keyVar: "ZHIPU_API_KEY", model: "glm-5.3-flash" },
  netways: { baseURL: "https://api.ai.nws.netways.de/qwen/v1", keyVar: "NETWAYS_API_KEY", model: "Qwen/Qwen3.8-27B" },
  "netways-gptoss": { baseURL: "https://api.ai.nws.netways.de/v1", keyVar: "NETWAYS_API_KEY", model: "openai/gpt-oss-20b" },
};

export function createLlm({ role = "chat" } = {}) {
  const chatName = (process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  const name = role === "batch" ? (process.env.LLM_BATCH_PROVIDER || chatName).toLowerCase() : chatName;
  const p = PROVIDERS[name] || { baseURL: process.env.LLM_BASE_URL, keyVar: "LLM_API_KEY", model: process.env.CHAT_MODEL };
  const apiKey = process.env.LLM_API_KEY || process.env[p.keyVar];
  if (!apiKey) {
    console.warn(`WARNING: no API key for LLM provider "${name}" (${p.keyVar} / LLM_API_KEY). Copy .env.example to .env and add it.`);
  }
  const client = new OpenAI({ baseURL: process.env.LLM_BASE_URL || p.baseURL, apiKey: apiKey || "missing" });
  const model = (role === "chat" && process.env.CHAT_MODEL) || p.model;
  let extra = {};
  if (name === "deepseek") {
    const think = role === "batch" ? "disabled" : (process.env.LLM_THINKING || "disabled").toLowerCase();
    extra = think === "disabled" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: think };
  } else if (name === "zhipu") {
    extra = { reasoning_effort: process.env.LLM_REASONING || "low" };
  } else if (name === "netways") {
    // vLLM Qwen3 chat template: thinking off unless LLM_THINKING asks for it.
    extra = { chat_template_kwargs: { enable_thinking: role !== "batch" && (process.env.LLM_THINKING || "disabled") !== "disabled" } };
  } else if (name === "netways-gptoss") {
    extra = { reasoning_effort: role === "batch" ? "low" : process.env.LLM_THINKING && process.env.LLM_THINKING !== "disabled" ? process.env.LLM_THINKING : "low" };
  }
  return { client, model, provider: name, extra, role };
}

// Batch jobs can spread requests over every provider with a key: both
// DeepSeek and Zhipu limit by request count, so two accounts are twice the
// throughput. LLM_BATCH_PROVIDER pins a single one.
export function createBatchPool() {
  if (process.env.LLM_BATCH_PROVIDER) return [createLlm({ role: "batch" })];
  const pool = [];
  for (const name of Object.keys(PROVIDERS)) {
    if (name === "netways-gptoss") continue; // same GPU and rate limit as netways
    if (!process.env[PROVIDERS[name].keyVar]) continue;
    const saved = process.env.LLM_BATCH_PROVIDER;
    process.env.LLM_BATCH_PROVIDER = name;
    pool.push(createLlm({ role: "batch" }));
    if (saved === undefined) delete process.env.LLM_BATCH_PROVIDER;
    else process.env.LLM_BATCH_PROVIDER = saved;
  }
  return pool.length ? pool : [createLlm({ role: "batch" })];
}
