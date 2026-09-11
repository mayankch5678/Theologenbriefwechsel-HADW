// One place for the chat-model client. Provider and model come from the
// environment; the default is Zhipu's glm-5.3-flash (user decision
// 2026-09-11), DeepSeek stays reachable by setting LLM_PROVIDER=deepseek.
//
//   LLM_PROVIDER   zhipu (default) | deepseek | openai-compatible (needs LLM_BASE_URL)
//   LLM_BASE_URL   override the provider's base URL
//   LLM_API_KEY    override the key (else ZHIPU_API_KEY / DEEPSEEK_API_KEY)
//   CHAT_MODEL     override the model id
//   LLM_REASONING  reasoning_effort for models that always think (glm-5.3-flash): low | medium | high
//
// Both endpoints speak the OpenAI chat-completions dialect including tools
// and response_format json_object (verified 2026-09-11 for both).

import OpenAI from "openai";

const PROVIDERS = {
  zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", keyVar: "ZHIPU_API_KEY", model: "glm-5.3-flash", reasoning: true },
  deepseek: { baseURL: "https://api.deepseek.com", keyVar: "DEEPSEEK_API_KEY", model: "deepseek-flash", reasoning: false },
};

export function createLlm() {
  const name = (process.env.LLM_PROVIDER || "zhipu").toLowerCase();
  const p = PROVIDERS[name] || { baseURL: process.env.LLM_BASE_URL, keyVar: "LLM_API_KEY", model: process.env.CHAT_MODEL, reasoning: false };
  const apiKey = process.env.LLM_API_KEY || process.env[p.keyVar];
  if (!apiKey) {
    console.warn(`WARNING: no API key for LLM provider "${name}" (${p.keyVar} / LLM_API_KEY). Copy .env.example to .env and add it.`);
  }
  const client = new OpenAI({ baseURL: process.env.LLM_BASE_URL || p.baseURL, apiKey: apiKey || "missing" });
  const model = process.env.CHAT_MODEL || p.model;
  // Extra request fields the provider understands. glm-5.3-flash always
  // reasons; reasoning_effort keeps that short for cheap structured tasks.
  const extra = p.reasoning ? { reasoning_effort: process.env.LLM_REASONING || "low" } : {};
  return { client, model, provider: name, extra };
}
