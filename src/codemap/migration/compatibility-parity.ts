import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeHashedCodemapId } from "../model/ids.js";
import { CODEMAP_FILES } from "../model/layout.js";
import type { PublishIncident, RenderedView } from "../model/types.js";

export type CompatibilityParityStatus =
  | "match"
  | "drift"
  | "missing_compatibility"
  | "extra_compatibility"
  | "no_legacy_baseline";

export interface CompatibilityParityArticle {
  article: string;
  status: CompatibilityParityStatus;
  similarity: number | null;
  legacyTitle?: string;
  compatibilityTitle?: string;
  notes: string[];
}

export interface CompatibilityParitySummary {
  legacyArticles: number;
  compatibilityArticles: number;
  matched: number;
  drifted: number;
  missingCompatibility: number;
  extraCompatibility: number;
  noLegacyBaseline: number;
}

export interface CompatibilityParityReport {
  generatedAt: string;
  legacyWikiPresent: boolean;
  legacyWikiDir: string;
  compatibilityWikiDir: string;
  summary: CompatibilityParitySummary;
  articles: CompatibilityParityArticle[];
}

export interface CompatibilityParityResult {
  report: CompatibilityParityReport;
  incidents: PublishIncident[];
}

export interface CompatibilityKnowledgeParityReport {
  generatedAt: string;
  legacyKnowledgePresent: boolean;
  legacyKnowledgePath: string;
  compatibilityKnowledgePath: string;
  article: CompatibilityParityArticle;
}

export interface CompatibilityKnowledgeParityResult {
  report: CompatibilityKnowledgeParityReport;
  incidents: PublishIncident[];
}

const LEGACY_WIKI_DIR = ".codesight/wiki";
const LEGACY_KNOWLEDGE_PATH = ".codesight/KNOWLEDGE.md";
const COMPATIBILITY_WIKI_PREFIX = ".codemap/compatibility/wiki/";
const COMPATIBILITY_KNOWLEDGE_PATH = ".codemap/compatibility/KNOWLEDGE.md";
const TITLE_NORMALIZE_PATTERN = /compatibility wiki|wiki/gi;
const SIMILARITY_THRESHOLD = 0.14;
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "that",
  "this",
  "these",
  "those",
  "into",
  "are",
  "not",
  "but",
  "its",
  "their",
  "here",
  "there",
  "view",
  "article",
  "derived",
  "generated",
  "legacy",
  "compatibility",
  "claims",
  "claim",
  "source",
  "sources",
  "code",
  "codemap",
  "wiki",
  "read",
  "before",
  "back",
  "current",
  "currently",
]);

interface ArticleContent {
  title: string;
  content: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function getCompatibilityArticles(views: RenderedView[]): Map<string, string> {
  return new Map(
    views
      .filter((view) => view.path.startsWith(COMPATIBILITY_WIKI_PREFIX))
      .map((view) => [view.path.slice(COMPATIBILITY_WIKI_PREFIX.length), view.markdown]),
  );
}

async function readLegacyArticles(repoRoot: string): Promise<Map<string, string>> {
  const legacyDir = join(repoRoot, LEGACY_WIKI_DIR);
  if (!(await pathExists(legacyDir))) {
    return new Map();
  }

  const files = await readdir(legacyDir);
  const articles = new Map<string, string>();

  for (const file of files.sort()) {
    if (!file.endsWith(".md") || file === "log.md") {
      continue;
    }
    try {
      articles.set(file, await readFile(join(legacyDir, file), "utf-8"));
    } catch {
      continue;
    }
  }

  return articles;
}

function extractTitle(content: string, fallback: string): string {
  const titleLine = content
    .split(/\r?\n/)
    .find((line) => line.startsWith("# "));
  return titleLine ? titleLine.slice(2).trim() : fallback.replace(/\.md$/, "");
}

function normalizeTitle(title: string): string {
  return title
    .replace(TITLE_NORMALIZE_PATTERN, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function tokenizeContent(content: string): Set<string> {
  const normalized = content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/^>\s.*$/gm, " ")
    .replace(/^_.*$/gm, " ")
    .replace(/^---$/gm, " ")
    .replace(/`+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase();

  return new Set(
    normalized
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !STOP_WORDS.has(token)),
  );
}

function computeSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeContent(left);
  const rightTokens = tokenizeContent(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function buildArticleContentMap(rawArticles: Map<string, string>): Map<string, ArticleContent> {
  return new Map(
    [...rawArticles.entries()].map(([article, content]) => [
      article,
      {
        title: extractTitle(content, article),
        content,
      },
    ]),
  );
}

function createIncident(
  article: CompatibilityParityArticle,
  createdAt: string,
  severity: PublishIncident["severity"],
  message: string
): PublishIncident {
  return {
    id: makeHashedCodemapId("incident", [article.article, article.status, createdAt, message]),
    createdAt,
    severity,
    message,
    claimIds: [],
  };
}

function buildIncidents(articles: CompatibilityParityArticle[], createdAt: string): PublishIncident[] {
  const incidents: PublishIncident[] = [];

  for (const article of articles) {
    if (article.status === "missing_compatibility") {
      incidents.push(createIncident(
        article,
        createdAt,
        "medium",
        `Legacy wiki article ${article.article} has no CodeMap compatibility counterpart yet.`,
      ));
    } else if (article.status === "drift") {
      const similarity = article.similarity === null ? "n/a" : article.similarity.toFixed(2);
      incidents.push(createIncident(
        article,
        createdAt,
        "low",
        `Compatibility wiki article ${article.article} diverges from the legacy wiki baseline (similarity ${similarity}).`,
      ));
    }
  }

  return incidents.sort((left, right) => left.id.localeCompare(right.id));
}

export async function compareCompatibilityWiki(
  repoRoot: string,
  views: RenderedView[],
  generatedAt: string,
): Promise<CompatibilityParityResult> {
  const compatibilityArticles = buildArticleContentMap(getCompatibilityArticles(views));
  const legacyArticles = buildArticleContentMap(await readLegacyArticles(repoRoot));
  const legacyWikiPresent = legacyArticles.size > 0;
  const articleNames = [...new Set([...legacyArticles.keys(), ...compatibilityArticles.keys()])].sort();

  const articles: CompatibilityParityArticle[] = articleNames.map((article) => {
    const legacy = legacyArticles.get(article);
    const compatibility = compatibilityArticles.get(article);

    if (!legacyWikiPresent) {
      return {
        article,
        status: "no_legacy_baseline",
        similarity: null,
        compatibilityTitle: compatibility?.title,
        notes: ["legacy wiki baseline not present"],
      };
    }

    if (legacy && !compatibility) {
      return {
        article,
        status: "missing_compatibility",
        similarity: null,
        legacyTitle: legacy.title,
        notes: ["legacy wiki article exists but CodeMap compatibility article is missing"],
      };
    }

    if (!legacy && compatibility) {
      return {
        article,
        status: "extra_compatibility",
        similarity: null,
        compatibilityTitle: compatibility.title,
        notes: ["CodeMap compatibility article has no legacy wiki baseline counterpart"],
      };
    }

    const similarity = computeSimilarity(legacy!.content, compatibility!.content);
    const titlesMatch = normalizeTitle(legacy!.title) === normalizeTitle(compatibility!.title);
    const status: CompatibilityParityStatus = titlesMatch || similarity >= SIMILARITY_THRESHOLD
      ? "match"
      : "drift";

    const notes: string[] = [];
    if (!titlesMatch) {
      notes.push("titles differ after normalization");
    }
    if (similarity < SIMILARITY_THRESHOLD) {
      notes.push(`content similarity below threshold (${SIMILARITY_THRESHOLD.toFixed(2)})`);
    }

    return {
      article,
      status,
      similarity,
      legacyTitle: legacy!.title,
      compatibilityTitle: compatibility!.title,
      notes,
    };
  });

  const report: CompatibilityParityReport = {
    generatedAt,
    legacyWikiPresent,
    legacyWikiDir: LEGACY_WIKI_DIR,
    compatibilityWikiDir: COMPATIBILITY_WIKI_PREFIX.slice(0, -1),
    summary: {
      legacyArticles: legacyArticles.size,
      compatibilityArticles: compatibilityArticles.size,
      matched: articles.filter((article) => article.status === "match").length,
      drifted: articles.filter((article) => article.status === "drift").length,
      missingCompatibility: articles.filter((article) => article.status === "missing_compatibility").length,
      extraCompatibility: articles.filter((article) => article.status === "extra_compatibility").length,
      noLegacyBaseline: articles.filter((article) => article.status === "no_legacy_baseline").length,
    },
    articles,
  };

  return {
    report,
    incidents: legacyWikiPresent ? buildIncidents(articles, generatedAt) : [],
  };
}

export async function compareCompatibilityKnowledge(
  repoRoot: string,
  views: RenderedView[],
  generatedAt: string,
): Promise<CompatibilityKnowledgeParityResult> {
  const compatibilityView = views.find((view) => view.path === COMPATIBILITY_KNOWLEDGE_PATH);
  const legacyKnowledgePath = join(repoRoot, LEGACY_KNOWLEDGE_PATH);
  const legacyKnowledgePresent = await fileExists(legacyKnowledgePath);
  const legacyContent = legacyKnowledgePresent ? await readFile(legacyKnowledgePath, "utf-8") : null;
  const compatibilityContent = compatibilityView?.markdown ?? null;

  let article: CompatibilityParityArticle;
  if (!legacyKnowledgePresent) {
    article = {
      article: "KNOWLEDGE.md",
      status: "no_legacy_baseline",
      similarity: null,
      compatibilityTitle: compatibilityContent ? extractTitle(compatibilityContent, "KNOWLEDGE.md") : undefined,
      notes: ["legacy knowledge baseline not present"],
    };
  } else if (!compatibilityContent) {
    article = {
      article: "KNOWLEDGE.md",
      status: "missing_compatibility",
      similarity: null,
      legacyTitle: extractTitle(legacyContent!, "KNOWLEDGE.md"),
      notes: ["legacy knowledge article exists but CodeMap compatibility knowledge article is missing"],
    };
  } else {
    const legacyTitle = extractTitle(legacyContent!, "KNOWLEDGE.md");
    const compatibilityTitle = extractTitle(compatibilityContent, "KNOWLEDGE.md");
    const similarity = computeSimilarity(legacyContent!, compatibilityContent);
    const titlesMatch = normalizeTitle(legacyTitle) === normalizeTitle(compatibilityTitle);
    const status: CompatibilityParityStatus = titlesMatch || similarity >= SIMILARITY_THRESHOLD
      ? "match"
      : "drift";
    const notes: string[] = [];
    if (!titlesMatch) {
      notes.push("titles differ after normalization");
    }
    if (similarity < SIMILARITY_THRESHOLD) {
      notes.push(`content similarity below threshold (${SIMILARITY_THRESHOLD.toFixed(2)})`);
    }

    article = {
      article: "KNOWLEDGE.md",
      status,
      similarity,
      legacyTitle,
      compatibilityTitle,
      notes,
    };
  }

  return {
    report: {
      generatedAt,
      legacyKnowledgePresent,
      legacyKnowledgePath: LEGACY_KNOWLEDGE_PATH,
      compatibilityKnowledgePath: COMPATIBILITY_KNOWLEDGE_PATH,
      article,
    },
    incidents: legacyKnowledgePresent ? buildIncidents([article], generatedAt) : [],
  };
}

export function getCompatibilityParityPath(): string {
  return CODEMAP_FILES.compatibilityParity;
}
