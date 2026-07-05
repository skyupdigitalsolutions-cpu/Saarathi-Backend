import OpenAI from "openai";

let client = null;

export function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in .env");
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || "gpt-4o-mini";
export const COPILOT_MODEL = process.env.COPILOT_MODEL || "gpt-4o";
