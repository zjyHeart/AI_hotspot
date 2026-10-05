import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { settings } from "./schema";
import type { Health, Settings, Publisher } from "../shared/types";
import { AI_CODING_ACCOUNTS } from "../shared/x-accounts";
export function readSetting<T>(key: string, fallback: T): T {
  return (
    (getDb().select().from(settings).where(eq(settings.key, key)).get()
      ?.value as T | undefined) ?? fallback
  );
}
export function writeSetting(key: string, value: unknown) {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
export const DEFAULT_PUBLISHERS: Publisher[] = [
  {
    id: "cline",
    name: "Cline",
    domains: ["cline.bot"],
    xAccounts: ["cline"],
    githubOwners: ["cline"],
    proofUrl: "https://cline.bot/",
  },
  {
    id: "opencode",
    name: "OpenCode",
    domains: ["opencode.ai"],
    xAccounts: ["opencode"],
    githubOwners: ["anomalyco"],
    proofUrl: "https://github.com/anomalyco/opencode",
  },
  {
    id: "langchain",
    name: "LangChain",
    domains: ["langchain.com"],
    xAccounts: ["LangChain"],
    githubOwners: [],
    proofUrl: "https://www.langchain.com/",
  },
  {
    id: "openai",
    name: "OpenAI",
    domains: ["openai.com"],
    xAccounts: ["openai"],
    githubOwners: ["openai"],
    proofUrl: "https://openai.com/",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    domains: ["anthropic.com"],
    xAccounts: ["anthropicai"],
    githubOwners: ["anthropics"],
    proofUrl: "https://www.anthropic.com/",
  },
  {
    id: "google",
    name: "Google / DeepMind",
    domains: ["blog.google", "deepmind.google"],
    xAccounts: ["googleai", "googledeepmind"],
    githubOwners: ["google", "google-deepmind"],
    proofUrl: "https://deepmind.google/",
  },
  {
    id: "microsoft",
    name: "Microsoft",
    domains: ["microsoft.com"],
    xAccounts: ["microsoft"],
    githubOwners: ["microsoft"],
    proofUrl: "https://www.microsoft.com/",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    domains: ["huggingface.co"],
    xAccounts: ["huggingface"],
    githubOwners: ["huggingface"],
    proofUrl: "https://huggingface.co/",
  },
  {
    id: "github",
    name: "GitHub",
    domains: ["github.blog"],
    xAccounts: ["github"],
    githubOwners: ["github"],
    proofUrl: "https://github.blog/",
  },
  {
    id: "vercel",
    name: "Vercel",
    domains: ["vercel.com"],
    xAccounts: ["vercel"],
    githubOwners: ["vercel"],
    proofUrl: "https://vercel.com/",
  },
  {
    id: "cursor",
    name: "Cursor",
    domains: ["cursor.com"],
    xAccounts: ["cursor_ai"],
    githubOwners: [],
    proofUrl: "https://cursor.com/",
  },
  {
    id: "techcrunch",
    name: "TechCrunch",
    domains: ["techcrunch.com"],
    xAccounts: [],
    githubOwners: [],
    proofUrl: "https://techcrunch.com/",
  },
  {
    id: "arstechnica",
    name: "Ars Technica",
    domains: ["arstechnica.com"],
    xAccounts: [],
    githubOwners: [],
    proofUrl: "https://arstechnica.com/",
  },
];
export function getSettings(): Settings {
  const defaults: Settings = {
    xAccounts: AI_CODING_ACCOUNTS,
    xDailyRequestLimit: 144,
    xMonthlyRequestLimit: 4320,
    xRequestsPerScan: 3,
    thinkingMode: "disabled",
    analysisEnabled: false,
    xContextDailyLimit: 10,
    aiDailyCallLimit: 60,
    aiDailyTokenLimit: 200000,
    candidateLimit: 200,
    eventWindowHours: 72,
    minValue: 60,
    webPages: 1,
    defaultInterval: Number(process.env.SCAN_INTERVAL_MINUTES) || 30,
    model: process.env.AI_MODEL || "",
    baseUrl: process.env.PACKY_BASE_URL || "https://cf.api.fan/v1",
    outputMode: (process.env.AI_OUTPUT_MODE ||
      "json_object") as Settings["outputMode"],
    maxPages: Math.min(10, Number(process.env.SCAN_MAX_PAGES) || 3),
    batchSize: Math.min(5, Number(process.env.AI_BATCH_SIZE) || 3),
    searchDailyLimit: 30,
    searchMonthlyLimit: 900,
    verificationDailyLimit: 6,
    bodyFetchLimit: 6,
    publishers: DEFAULT_PUBLISHERS,
  };
  const stored = readSetting<Partial<Settings>>("app", {});
  const publishers =
    stored.publishers && stored.xAccounts === undefined
      ? [
          ...stored.publishers,
          ...DEFAULT_PUBLISHERS.filter(
            (p) =>
              ["cline", "opencode", "langchain"].includes(p.id) &&
              !stored.publishers!.some((old) => old.id === p.id),
          ),
        ]
      : stored.publishers || defaults.publishers;
  return {
    ...defaults,
    ...stored,
    publishers,
    model: stored.model || defaults.model,
  };
}
export function emailConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASSWORD &&
    process.env.EMAIL_FROM &&
    process.env.EMAIL_TO,
  );
}
export function getHealth(): Health {
  const workerAt = readSetting<number | null>("workerAt", null);
  return {
    x: Boolean(process.env.TWITTERAPI_API_KEY),
    ai: Boolean(process.env.PACKY_API_KEY && getSettings().model),
    email: emailConfigured(),
    github: Boolean(process.env.GITHUB_TOKEN),
    search: Boolean(process.env.SERPAPI_API_KEY),
    worker: workerAt !== null && Date.now() - workerAt < 30000,
    workerAt,
  };
}
