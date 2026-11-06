import { afterEach, describe, expect, test } from "vitest";
import { getAiConfig } from "./config";

const KEYS = ["AI_PROVIDER", "AI_MODEL", "AI_API_KEY", "AI_BASE_URL", "AI_STRUCTURED_OUTPUTS"];

describe("getAiConfig structuredOutputs", () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  function setCustom(structured?: string) {
    process.env.AI_PROVIDER = "custom";
    process.env.AI_MODEL = "qwen3.6:27b";
    process.env.AI_BASE_URL = "http://localhost:11434/v1";
    if (structured !== undefined) process.env.AI_STRUCTURED_OUTPUTS = structured;
  }

  test("defaults to false", () => {
    setCustom();
    expect(getAiConfig()?.structuredOutputs).toBe(false);
  });

  test("true when AI_STRUCTURED_OUTPUTS=true", () => {
    setCustom("true");
    expect(getAiConfig()?.structuredOutputs).toBe(true);
  });
});
