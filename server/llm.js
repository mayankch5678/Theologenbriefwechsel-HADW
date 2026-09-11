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

const PROVIDERS = {
  deepseek: { baseURL: "https://api.deepseek.com", keyVar: "DEEPSEEK_API_KEY", model: "deepseek-flash" },
  zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", keyVar: "ZHIPU_API_KEY", model: "glm-5.3-flash" },
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
  }
  return { client, model, provider: name, extra, role };
}
