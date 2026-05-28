import type { ManagedToolDefinition, ToolExecutionContext } from "./ToolCore.js"

export type RustSearchAction = "search" | "crate" | "item" | "std" | "migrations" | "url" | "sources"

export interface RustSearchArgs {
  action: RustSearchAction
  query?: string
  crate?: string
  crateName?: string
  item?: string
  url?: string
  version?: string
  limit?: number
  maxResults?: number
  refresh?: boolean
}

interface RustdocItem {
  name: string
  kind: string
  url: string
  score: number
}

const SOURCES = {
  std: "https://doc.rust-lang.org/std/",
  book: "https://doc.rust-lang.org/book/",
  reference: "https://doc.rust-lang.org/reference/",
  editionGuide: "https://doc.rust-lang.org/edition-guide/",
  cargo: "https://doc.rust-lang.org/cargo/",
  rustdoc: "https://doc.rust-lang.org/rustdoc/",
  crates: "https://crates.io",
  docs: "https://docs.rs",
}

export const rustsearchTool: ManagedToolDefinition<RustSearchArgs> = {
  name: "rustsearch",
  description: "查询 Rust 官方文档、标准库条目、crate 元数据、docs.rs 文档入口和版本迁移资料。",
  promptHint: "需要 Rust API、crate 元数据、标准库条目、具体条目页面、显式文档URL或版本迁移资料时使用。action 支持 search/crate/item/std/migrations/url/sources。",
  audiences: ["opencode", "codex"],
  command: "rustsearch({ action, query?, crate?, crateName?, item?, url?, version?, limit?, refresh? })",
  args: {
    action: {
      type: "enum",
      values: ["search", "crate", "item", "std", "migrations", "url", "sources"],
      description: "search=综合搜索入口, crate=查询 crate 根文档, item=查询 crate/std API 条目, std=查询标准库条目, migrations=Rust 迁移资料, url=清理指定Rust文档URL, sources=列出可信来源",
    },
    query: { type: "string", description: "搜索关键词，例如 Vec、tokio、edition 2024", optional: true },
    crate: { type: "string", description: "crate 名称，例如 tokio、serde；标准库可用 std/core/alloc", optional: true },
    crateName: { type: "string", description: "crate 名称，例如 tokio、serde，兼容旧参数", optional: true },
    item: { type: "string", description: "API 条目，例如 Serialize、Vec::retain", optional: true },
    url: { type: "string", description: "明确的 Rust 文档 URL，仅允许 doc.rust-lang.org、docs.rs、crates.io", optional: true },
    version: { type: "string", description: "crate 版本，不填则使用 docs.rs/latest", optional: true },
    limit: { type: "number", description: "最多返回结果数，默认 5", optional: true },
    maxResults: { type: "number", description: "最多返回结果数，兼容旧参数", optional: true },
    refresh: { type: "boolean", description: "兼容 rustdoc 项目的刷新缓存语义；当前内置实现不持久缓存", optional: true },
  },
  async run(args, context) {
    return await runRustSearch(args, context)
  },
}

export async function runRustSearch(args: RustSearchArgs, _context: ToolExecutionContext = { cwd: process.cwd() }): Promise<string> {
  const maxResults = clampNumber(args.limit ?? args.maxResults, 1, 20, 5)
  const crateName = args.crate ?? args.crateName

  switch (args.action) {
    case "sources":
      return formatSources()
    case "migrations":
      return await formatMigrations(args.query, maxResults)
    case "crate":
      return await formatCrate(crateName ?? args.query, args.version)
    case "item":
      return await formatItem(crateName ?? "std", args.item ?? args.query, args.version, maxResults)
    case "url":
      return await formatUrl(args.url)
    case "std":
      return await formatStd(args.query, maxResults)
    case "search":
      return await formatSearch(args.query, maxResults, crateName, args.version)
    default:
      return "Unsupported action."
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function formatSources(): string {
  return [
    "Rust documentation sources used by this tool:",
    `- Standard library rustdoc: ${SOURCES.std}`,
    "- Core/alloc rustdoc: https://doc.rust-lang.org/core/ and https://doc.rust-lang.org/alloc/",
    `- The Rust Book: ${SOURCES.book}`,
    `- Rust Reference: ${SOURCES.reference}`,
    `- Crate API docs: ${SOURCES.docs}`,
    "- Crate metadata/search: https://crates.io/api/v1/crates",
    `- Edition Guide: ${SOURCES.editionGuide}`,
    "- Release notes: https://doc.rust-lang.org/releases.html",
    "- Cargo resolver migration notes: https://doc.rust-lang.org/cargo/reference/resolver.html",
  ].join("\n")
}

async function formatMigrations(query?: string, maxResults = 5): Promise<string> {
  const q = query?.trim()
  const urls = [
    `${SOURCES.editionGuide}rust-2024/index.html`,
    `${SOURCES.editionGuide}rust-2024/summary.html`,
    `${SOURCES.editionGuide}rust-2024/unsafe-attributes.html`,
    `${SOURCES.editionGuide}rust-2024/unsafe-op-in-unsafe-fn.html`,
    `${SOURCES.editionGuide}rust-2021/index.html`,
    `${SOURCES.editionGuide}rust-2021/intoiterator-for-arrays.html`,
    `${SOURCES.editionGuide}rust-2021/disjoint-capture-in-closures.html`,
    "https://doc.rust-lang.org/releases.html",
    `${SOURCES.cargo}reference/resolver.html`,
  ]

  if (!q) {
    return ["Rust migration references:", ...urls.map(url => `- ${url}`)].join("\n")
  }

  const matches: string[] = []
  for (const url of urls) {
    try {
      const cleaned = cleanHtml(await fetchText(url))
      const paragraphs = cleaned.text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
      const ranked = rankTextMatches(paragraphs, q).slice(0, 2)
      for (const match of ranked) {
        matches.push(`- ${cleaned.title}\n  Source: ${url}\n  ${trimChars(match, 500)}`)
      }
    } catch {
      // Keep searching other migration sources.
    }
    if (matches.length >= maxResults) break
  }

  if (matches.length > 0) {
    return [`Rust migration/release-note search for "${q}":`, ...matches.slice(0, maxResults)].join("\n")
  }

  return [`No migration matches found for "${q}". Sources searched:`, ...urls.map(url => `- ${url}`)].join("\n")
}

async function formatCrate(crateName?: string, version?: string): Promise<string> {
  const name = sanitizeCrateName(crateName)
  if (!name) return "crate action requires crate or crateName or query."

  if (isStdCrate(name)) {
    return await fetchCleanPage(stdCrateUrl(name))
  }

  const docsUrl = docsRsCrateRoot(name, version)

  try {
    const meta = await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)
    const crateInfo = meta?.crate
    const cleaned = await fetchCleanPage(docsUrl).catch(() => undefined)
    if (!crateInfo) {
      return [`No crates.io metadata found for ${name}.`, `- docs.rs: ${docsUrl}`, `- crates.io: https://crates.io/crates/${encodeURIComponent(name)}`].join("\n")
    }

    return [
      `Crate: ${crateInfo.name}`,
      `Latest version: ${crateInfo.max_version ?? version ?? "latest"}`,
      crateInfo.description ? `Description: ${crateInfo.description}` : undefined,
      crateInfo.documentation ? `Documentation: ${crateInfo.documentation}` : undefined,
      crateInfo.repository ? `Repository: ${crateInfo.repository}` : undefined,
      crateInfo.homepage ? `Homepage: ${crateInfo.homepage}` : undefined,
      `Crates.io: https://crates.io/crates/${encodeURIComponent(name)}`,
      `Docs.rs: ${docsUrl}`,
      cleaned ? `\n${cleaned}` : undefined,
    ].filter(Boolean).join("\n")
  } catch (err) {
    return [`Failed to fetch crates.io metadata for ${name}: ${(err as Error).message}`, `- docs.rs: ${docsUrl}`, `- crates.io: https://crates.io/crates/${encodeURIComponent(name)}`].join("\n")
  }
}

async function formatStd(query?: string, maxResults = 5): Promise<string> {
  const q = query?.trim()
  if (!q) return "std action requires query."

  const allItemsUrl = `${SOURCES.std}all.html`
  try {
    const matches = findStdMatches(await fetchText(allItemsUrl), q, maxResults)
    if (matches.length === 0) {
      return [`No exact standard-library index matches for "${q}".`, `- std index: ${allItemsUrl}`, `- search in browser: ${SOURCES.std}?search=${encodeURIComponent(q)}`].join("\n")
    }

    return [`Standard library matches for "${q}":`, ...matches.map(item => `- ${item.name}: ${new URL(item.href, SOURCES.std).toString()}`)].join("\n")
  } catch (err) {
    return [`Failed to fetch Rust standard library index: ${(err as Error).message}`, `- std index: ${allItemsUrl}`, `- search in browser: ${SOURCES.std}?search=${encodeURIComponent(q)}`].join("\n")
  }
}

async function formatItem(crateName: string, item?: string, version?: string, maxResults = 5): Promise<string> {
  const q = item?.trim()
  if (!q) return "item action requires item or query."

  const crateId = sanitizeCrateName(crateName) ?? "std"
  const allItemsUrl = isStdCrate(crateId)
    ? `${stdCrateUrl(crateId).replace(/\/$/, "")}/all.html`
    : docsRsAllItems(crateId, version)

  try {
    const html = await fetchText(allItemsUrl)
    const matches = rankItems(extractRustdocItems(html, allItemsUrl), q).slice(0, maxResults)
    if (matches.length === 0) return `No rustdoc item matches found for "${q}" in ${crateId}.\nIndex: ${allItemsUrl}`

    const best = matches[0]!
    const cleaned = await fetchCleanPage(best.url).catch(() => undefined)
    return [
      `Best match: ${best.name} (${best.kind})`,
      `Source: ${best.url}`,
      "",
      cleaned ?? "Could not fetch cleaned item page.",
      "",
      matches.length > 1 ? "Other matches:" : "",
      ...matches.slice(1).map((match, index) => `${index + 1}. ${match.name} (${match.kind})\n   ${match.url}`),
    ].filter(Boolean).join("\n")
  } catch (err) {
    return [`Failed to search rustdoc items for ${crateId}: ${(err as Error).message}`, `Index: ${allItemsUrl}`].join("\n")
  }
}

async function formatUrl(url?: string): Promise<string> {
  if (!url?.trim()) return "url action requires url."

  try {
    const parsed = new URL(url)
    if (!isAllowedRustDocHost(parsed.hostname)) return `Refusing URL outside known Rust documentation hosts: ${url}`
    return await fetchCleanPage(parsed.toString())
  } catch (err) {
    return `Failed to fetch Rust documentation URL: ${(err as Error).message}`
  }
}

async function formatSearch(query?: string, maxResults = 5, crateName?: string, version?: string): Promise<string> {
  const q = query?.trim()
  if (!q) return "search action requires query."
  if (crateName) return await formatItem(crateName, q, version, maxResults)

  const crateResults = await searchCrates(q, maxResults).catch(() => [])
  const stdResults = await findStdSearchResults(q, maxResults).catch(() => [])
  const lines = [
    `Rust documentation search for "${q}"`,
    "",
    "Standard library matches:",
    ...(stdResults.length > 0
      ? stdResults.map((item, index) => `${index + 1}. ${item.name}\n   ${new URL(item.href, SOURCES.std).toString()}`)
      : ["No matches."]),
    "",
    "Crates.io matches:",
    ...(crateResults.length > 0
      ? crateResults.map((crateInfo, index) => {
          const suffix = crateInfo.description ? ` - ${crateInfo.description}` : ""
          return `${index + 1}. ${crateInfo.name} (crate ${crateInfo.max_version ?? "unknown"})${suffix}\n   https://docs.rs/${encodeURIComponent(crateInfo.name)}/latest/${encodeURIComponent(crateInfo.name.replace(/-/g, "_"))}/`
        })
      : ["No matches."]),
  ]

  return lines.join("\n")
}

async function searchCrates(query: string, maxResults: number): Promise<any[]> {
  const data = await fetchJson(`https://crates.io/api/v1/crates?page=1&per_page=${maxResults}&q=${encodeURIComponent(query)}`)
  return Array.isArray(data?.crates) ? data.crates.slice(0, maxResults) : []
}

async function findStdSearchResults(query: string, maxResults: number): Promise<Array<{ name: string; href: string }>> {
  return findStdMatches(await fetchText(`${SOURCES.std}all.html`), query, maxResults)
}

function findStdMatches(html: string, query: string, maxResults: number): Array<{ name: string; href: string }> {
  const normalized = query.toLowerCase()
  const matches: Array<{ name: string; href: string }> = []
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gims
  let match: RegExpExecArray | null

  while ((match = re.exec(html)) && matches.length < maxResults) {
    const href = decodeHtml(match[1] ?? "")
    const name = decodeHtml(stripTags(match[2] ?? "")).trim()
    if (!name) continue
    if (name.toLowerCase().includes(normalized) || href.toLowerCase().includes(normalized)) {
      matches.push({ name, href })
    }
  }

  return matches
}

function extractRustdocItems(html: string, baseUrl: string): RustdocItem[] {
  const rows = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  const results: RustdocItem[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const href = decodeHtml(row[1] ?? "").trim()
    const rawLabel = decodeHtml(stripTags(row[2] ?? "")).trim()
    if (!href || !rawLabel || !isRustdocItemHref(href)) continue

    const url = new URL(href, baseUrl).toString()
    if (seen.has(url)) continue
    seen.add(url)
    results.push({ name: rawLabel.replace(/\s+/g, " "), kind: inferKindFromHref(href), url, score: 0 })
  }

  return results
}

function rankItems(results: RustdocItem[], query: string): RustdocItem[] {
  const normalizedQuery = normalizeToken(query)
  const queryTokens = tokenize(query)

  return results
    .map((result) => {
      const normalizedName = normalizeToken(result.name)
      let score = 0
      if (normalizedName === normalizedQuery) score += 100
      if (normalizedName.endsWith(normalizedQuery)) score += 60
      if (normalizedName.includes(normalizedQuery)) score += 30
      for (const token of queryTokens) {
        if (normalizedName === token) score += 50
        if (normalizedName.endsWith(token)) score += 25
        if (normalizedName.includes(token)) score += 10
      }
      return { ...result, score }
    })
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

function rankTextMatches(values: string[], query: string): string[] {
  const tokens = tokenize(query)
  return values
    .map(value => ({
      value,
      score: tokens.reduce((score, token) => score + (normalizeToken(value).includes(token) ? token.length : 0), 0),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.value)
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetchWithTimeout(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return await res.json()
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return await res.text()
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "ultimate-coder-rustsearch/0.1",
        accept: "application/json,text/html;q=0.9,*/*;q=0.8",
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchCleanPage(url: string): Promise<string> {
  const cleaned = cleanHtml(await fetchText(url))
  return [`# ${cleaned.title || "Rust documentation"}`, `Source: ${url}`, "", cleaned.text].join("\n").trim()
}

function cleanHtml(html: string): { title: string; text: string } {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "Untitled")
    .replace(/\s+-\s+Rust$/i, "")
    .trim()

  let body = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? html

  body = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<rustdoc-topbar\b[\s\S]*?<\/rustdoc-topbar>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, "\n\n$2\n")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => `\n\n\`\`\`rust\n${stripTags(code)}\n\`\`\`\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => `\`${stripTags(code)}\``)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")

  return { title, text: trimChars(normalizeText(decodeHtml(body)).trim(), 9_000) }
}

function docsRsCrateRoot(crateName: string, version: string | undefined): string {
  const docsCrate = crateName.replace(/-/g, "_")
  return `https://docs.rs/${crateName}/${version ?? "latest"}/${docsCrate}/`
}

function docsRsAllItems(crateName: string, version: string | undefined): string {
  const docsCrate = crateName.replace(/-/g, "_")
  return `https://docs.rs/${crateName}/${version ?? "latest"}/${docsCrate}/all.html`
}

function stdCrateUrl(crateName: string): string {
  return `https://doc.rust-lang.org/${crateName}/`
}

function isStdCrate(crateName: string): boolean {
  return ["std", "core", "alloc", "proc_macro", "test"].includes(crateName)
}

function sanitizeCrateName(value?: string): string | null {
  const name = value?.trim()
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return null
  return name
}

function isRustdocItemHref(href: string): boolean {
  return /(?:^|\/)(?:struct|enum|trait|fn|type|mod|macro|constant|static|union|primitive|attr)\.[^/?#]+\.html(?:#.*)?$/i.test(href)
    || /(?:^|\/)[^/?#]+\/index\.html$/i.test(href)
}

function inferKindFromHref(href: string): string {
  const match = href.match(/(?:^|\/)(struct|enum|trait|fn|type|mod|macro|constant|static|union|primitive|attr)\./i)
  if (match?.[1]) return match[1].toLowerCase()
  if (href.endsWith("/index.html")) return "module"
  return "item"
}

function isAllowedRustDocHost(hostname: string): boolean {
  return hostname === "doc.rust-lang.org"
    || hostname === "docs.rs"
    || hostname.endsWith(".docs.rs")
    || hostname === "crates.io"
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "")
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
}

function trimChars(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max).trimEnd()}\n\n[truncated]`
}

function tokenize(value: string): string[] {
  return normalizeToken(value).split(/[^a-z0-9_]+/).filter(token => token.length > 1)
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/::/g, " ").replace(/[^a-z0-9_]+/g, " ").trim()
}
