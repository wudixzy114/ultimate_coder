import { execFile } from "node:child_process"
import { access, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { ManagedToolDefinition, ToolExecutionContext } from "../core/ToolCore.js"

const execFileAsync = promisify(execFile)

export type RustLocalDocAction = "search" | "item" | "sources"

export interface RustLocalDocArgs {
  action: RustLocalDocAction
  query?: string
  crate?: string
  crateName?: string
  item?: string
  limit?: number
  maxResults?: number
  autoGenerate?: boolean
  generateDocs?: boolean
  maxChars?: number
}

interface RustdocItem {
  name: string
  kind: string
  file: string
  source: string
  score: number
}

interface Runtime {
  cwd: string
  signal?: AbortSignal
}

interface CommandResult {
  stdout: string
  stderr: string
}

const STD_CRATES = new Set(["std", "core", "alloc", "proc_macro", "test"])
const DEFAULT_LIMIT = 5
const DEFAULT_MAX_CHARS = 7_000
const DOC_BUILD_TIMEOUT_MS = 180_000
const COMMAND_TIMEOUT_MS = 20_000

export const rustlocaldocTool: ManagedToolDefinition<RustLocalDocArgs> = {
  name: "rustlocaldoc",
  description: "Search local Rust rustdoc HTML from the installed toolchain and the current project's target/doc, generating cargo docs when needed.",
  promptHint: "Use for Rust API answers that should match the local toolchain or current Cargo project dependencies. Prefer this before network rustsearch for std/core/alloc and project crate docs. Actions: search/item/sources.",
  audiences: ["opencode", "codex"],
  command: "rustlocaldoc({ action, query?, crate?, crateName?, item?, limit?, autoGenerate?, maxChars? })",
  args: {
    action: {
      type: "enum",
      values: ["search", "item", "sources"],
      description: "search=return concise local rustdoc matches, item=return the best cleaned item page, sources=show detected local doc locations",
    },
    query: { type: "string", description: "Search text such as Vec, read_to_string, tokio::spawn, or Serialize", optional: true },
    crate: { type: "string", description: "Crate name. std/core/alloc use rustup toolchain docs; dependencies use target/doc", optional: true },
    crateName: { type: "string", description: "Alias for crate", optional: true },
    item: { type: "string", description: "Item name for item action, for example Vec::retain or read_to_string", optional: true },
    limit: { type: "number", description: "Maximum result count, default 5", optional: true },
    maxResults: { type: "number", description: "Alias for limit", optional: true },
    autoGenerate: { type: "boolean", description: "Run cargo doc --quiet when project docs are missing. Defaults to true.", optional: true },
    generateDocs: { type: "boolean", description: "Alias for autoGenerate", optional: true },
    maxChars: { type: "number", description: "Maximum cleaned document characters for item action, default 7000", optional: true },
  },
  async run(args, context) {
    return await runRustLocalDoc(args, context)
  },
}

export async function runRustLocalDoc(args: RustLocalDocArgs, context: ToolExecutionContext = { cwd: process.cwd() }): Promise<string> {
  const runtime: Runtime = { cwd: context.cwd, signal: context.signal }
  const action = args.action
  const query = (args.item ?? args.query)?.trim()
  const explicitCrateName = normalizeCrateName(args.crate ?? args.crateName)
  const limit = clampNumber(args.limit ?? args.maxResults, 1, 20, DEFAULT_LIMIT)
  const maxChars = clampNumber(args.maxChars, 1_000, 20_000, DEFAULT_MAX_CHARS)
  const autoGenerate = args.autoGenerate ?? args.generateDocs ?? true

  if (action === "sources") return await formatSources(runtime, autoGenerate)
  if (!query) return `${action} action requires item or query.`

  const crateName = explicitCrateName ?? inferCrateFromPath(query)
  const docQuery = crateName ? stripCratePrefix(query, crateName) : query
  const localDocs = await resolveLocalDocs(runtime, crateName, autoGenerate)
  if (localDocs.notes.length > 0 && localDocs.roots.length === 0) {
    return [`No local Rust documentation roots are available.`, ...localDocs.notes.map(note => `- ${note}`)].join("\n")
  }

  const member = extractMemberLookup(docQuery)
  const searchText = member?.container ?? docQuery
  const allItems = await loadAllItems(localDocs.roots, crateName)
  const matches = rankItems(allItems, searchText).slice(0, Math.max(limit, member ? 10 : limit))

  if (matches.length === 0) {
    return [
      `No local rustdoc matches for "${query}".`,
      ...localDocs.notes.map(note => `- ${note}`),
      `Searched roots:`,
      ...localDocs.roots.map(root => `- ${root}`),
    ].join("\n")
  }

  if (action === "search") {
    return [
      `Local Rust documentation matches for "${query}":`,
      ...matches.slice(0, limit).map((item, index) => `${index + 1}. ${item.name} (${item.kind})\n   Source: ${item.source}\n   File: ${item.file}`),
      ...localDocs.notes.map(note => `- ${note}`),
    ].join("\n")
  }

  let best = matches[0]!
  let section: { id: string; text: string } | undefined
  if (member) {
    for (const candidate of matches) {
      const html = await readFile(candidate.file, "utf8").catch(() => undefined)
      section = html ? extractRustdocSection(html, candidateSectionIds(member.member), maxChars) : undefined
      if (section) {
        best = candidate
        break
      }
    }
  }

  const cleaned = section
    ? {
        title: `${best.name}::${member?.member}`,
        text: section.text,
        source: `${best.source}#${section.id}`,
      }
    : await cleanRustdocFile(best.file, best.source, maxChars)

  return [
    `Best local match: ${best.name} (${best.kind})`,
    `Source: ${cleaned.source}`,
    `File: ${best.file}`,
    "",
    `# ${cleaned.title}`,
    "",
    cleaned.text,
    "",
    matches.length > 1 ? "Other local matches:" : "",
    ...matches.filter(match => match.file !== best.file).slice(0, limit - 1).map((match, index) => `${index + 1}. ${match.name} (${match.kind})\n   ${match.source}`),
    ...localDocs.notes.map(note => `- ${note}`),
  ].filter(Boolean).join("\n")
}

async function formatSources(runtime: Runtime, autoGenerate: boolean): Promise<string> {
  const docs = await resolveLocalDocs(runtime, undefined, autoGenerate)
  const [toolchain, projectRoot] = await Promise.all([
    command("rustup", ["show", "active-toolchain"], runtime.cwd, COMMAND_TIMEOUT_MS, runtime.signal).catch(() => undefined),
    findCargoProjectRoot(runtime.cwd),
  ])

  return [
    "Local Rust documentation sources:",
    toolchain?.stdout.trim() ? `- Active toolchain: ${toolchain.stdout.trim()}` : "- Active toolchain: unavailable",
    projectRoot ? `- Cargo project: ${projectRoot}` : "- Cargo project: not found from current directory",
    ...docs.roots.map(root => `- Doc root: ${root}`),
    ...docs.notes.map(note => `- ${note}`),
  ].join("\n")
}

async function resolveLocalDocs(runtime: Runtime, crateName: string | undefined, autoGenerate: boolean): Promise<{ roots: string[]; notes: string[] }> {
  const roots: string[] = []
  const notes: string[] = []
  const wantsStd = !crateName || STD_CRATES.has(crateName)

  if (wantsStd) {
    const sysroot = await getSysroot(runtime).catch((err) => {
      notes.push(`rustc sysroot unavailable: ${(err as Error).message}`)
      return undefined
    })
    if (sysroot) {
      const rustupDocs = path.join(sysroot, "share", "doc", "rust", "html")
      if (await exists(rustupDocs)) roots.push(rustupDocs)
      else notes.push(`rustup docs not found at ${rustupDocs}. rustup component add rust-docs may be needed.`)
    }
  }

  const projectRoot = await findCargoProjectRoot(runtime.cwd)
  if (projectRoot) {
    let targetDoc = await getCargoTargetDoc(projectRoot, runtime).catch(() => path.join(projectRoot, "target", "doc"))
    if (await exists(targetDoc)) roots.push(targetDoc)
    else if (!wantsStd && autoGenerate) {
      notes.push(`target/doc missing; ran cargo doc --quiet in ${projectRoot}.`)
      await command("cargo", ["doc", "--quiet"], projectRoot, DOC_BUILD_TIMEOUT_MS, runtime.signal)
      targetDoc = await getCargoTargetDoc(projectRoot, runtime).catch(() => path.join(projectRoot, "target", "doc"))
      if (await exists(targetDoc)) roots.push(targetDoc)
      else notes.push(`cargo doc completed but target/doc was not found at ${targetDoc}.`)
    } else if (!wantsStd) {
      notes.push(`target/doc missing at ${targetDoc}; autoGenerate is false.`)
    }
  } else if (!wantsStd) {
    notes.push("No Cargo.toml found from current directory; cannot generate project dependency docs.")
  }

  return { roots: unique(roots), notes }
}

async function loadAllItems(roots: string[], crateName: string | undefined): Promise<RustdocItem[]> {
  const items: RustdocItem[] = []
  const crateDirName = crateName?.replace(/-/g, "_")

  for (const root of roots) {
    const allHtmlCandidates = crateDirName
      ? [path.join(root, crateDirName, "all.html"), path.join(root, crateName ?? "", "all.html")]
      : [path.join(root, "std", "all.html"), path.join(root, "core", "all.html"), path.join(root, "alloc", "all.html")]

    for (const allHtml of unique(allHtmlCandidates)) {
      if (!(await exists(allHtml))) continue
      const baseDir = path.dirname(allHtml)
      const html = await readFile(allHtml, "utf8")
      items.push(...extractRustdocItems(html, baseDir))
    }
  }

  return dedupeItems(items)
}

function extractRustdocItems(html: string, baseDir: string): RustdocItem[] {
  const rows = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  const results: RustdocItem[] = []

  for (const row of rows) {
    const href = decodeHtml(row[1] ?? "").trim()
    const rawLabel = decodeHtml(stripTags(row[2] ?? "")).trim()
    if (!href || !rawLabel || !isRustdocItemHref(href)) continue

    const file = path.resolve(baseDir, href.split("#")[0] ?? href)
    const label = rawLabel.replace(/\s+/g, " ")
    results.push({
      name: label,
      kind: inferKindFromHref(href),
      file,
      source: pathToRustdocSource(file, href.includes("#") ? href.split("#")[1] : undefined),
      score: 0,
    })
  }

  return results
}

function rankItems(results: RustdocItem[], query: string): RustdocItem[] {
  const normalizedQuery = normalizeToken(query)
  const queryTokens = tokenize(query)

  return results
    .map((result) => {
      const normalizedName = normalizeToken(result.name)
      const normalizedLeaf = normalizeToken(result.name.split("::").at(-1) ?? result.name)
      const pathName = normalizeToken(result.file)
      let score = 0
      if (normalizedName === normalizedQuery) score += 120
      if (normalizedLeaf === normalizedQuery) score += 110
      if (normalizedName.endsWith(normalizedQuery)) score += 70
      if (normalizedName.includes(normalizedQuery)) score += 35
      if (pathName.includes(normalizedQuery)) score += 15
      if (/[A-Z]/.test(query) && ["struct", "enum", "trait", "type"].includes(result.kind)) score += 35
      if (/[A-Z]/.test(query) && result.kind === "macro") score -= 180
      for (const token of queryTokens) {
        if (normalizedName === token) score += queryTokens.length > 1 ? 25 : 80
        if (normalizedLeaf === token) score += queryTokens.length > 1 ? 20 : 70
        if (normalizedName.endsWith(token)) score += queryTokens.length > 1 ? 20 : 40
        if (normalizedName.includes(token)) score += 15
        if (pathName.includes(token)) score += 8
      }
      return { ...result, score }
    })
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

async function cleanRustdocFile(file: string, source: string, maxChars: number): Promise<{ title: string; text: string; source: string }> {
  const html = await readFile(file, "utf8")
  const cleaned = cleanHtml(html, maxChars)
  return { ...cleaned, source }
}

function cleanHtml(html: string, maxChars: number): { title: string; text: string } {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "Rust documentation")
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

  return { title, text: trimChars(normalizeText(decodeHtml(body)).trim(), maxChars) }
}

function extractRustdocSection(html: string, ids: string[], maxChars: number): { id: string; text: string } | undefined {
  for (const id of ids) {
    const index = html.indexOf(`id="${id}"`)
    if (index < 0) continue

    const detailsStart = html.lastIndexOf("<details", index)
    const sectionStart = html.lastIndexOf("<section", index)
    const start = detailsStart >= 0 && index - detailsStart < 1_500 ? detailsStart : Math.max(0, sectionStart)
    const detailsEnd = html.indexOf("</details>", index)
    const nextSection = html.indexOf("<section", index + id.length)
    const end = detailsEnd >= 0 ? detailsEnd + "</details>".length : nextSection > index ? nextSection : index + 10_000
    return { id, text: cleanHtml(`<main>${html.slice(start, end)}</main>`, maxChars).text }
  }
  return undefined
}

function extractMemberLookup(query: string): { container: string; member: string } | undefined {
  const explicit = query.match(/^\s*([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)::([A-Za-z_][\w]*)\s*$/)
  if (explicit?.[1] && explicit[2]) {
    const container = explicit[1].split("::").at(-1)
    if (container && /^[A-Z]/.test(container)) return { container, member: explicit[2] }
  }
  return undefined
}

function candidateSectionIds(member: string): string[] {
  return [
    `method.${member}`,
    `tymethod.${member}`,
    `associatedconstant.${member}`,
    `associatedtype.${member}`,
    `impl-${member}`,
  ]
}

async function getSysroot(runtime: Runtime): Promise<string> {
  const result = await command("rustc", ["--print", "sysroot"], runtime.cwd, COMMAND_TIMEOUT_MS, runtime.signal)
  return result.stdout.trim()
}

async function getCargoTargetDoc(projectRoot: string, runtime: Runtime): Promise<string> {
  const result = await command("cargo", ["metadata", "--format-version=1", "--no-deps"], projectRoot, COMMAND_TIMEOUT_MS, runtime.signal)
  const metadata = JSON.parse(result.stdout)
  if (typeof metadata.target_directory === "string") return path.join(metadata.target_directory, "doc")
  return path.join(projectRoot, "target", "doc")
}

async function findCargoProjectRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir)
  while (true) {
    const manifest = path.join(current, "Cargo.toml")
    if (await exists(manifest)) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function command(file: string, args: string[], cwd: string, timeout: number, signal?: AbortSignal): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      timeout,
      signal,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8,
    })
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } catch (err) {
    const error = err as Error & { stdout?: Buffer | string; stderr?: Buffer | string }
    const stderr = error.stderr?.toString().trim()
    throw new Error(stderr || error.message)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
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

function normalizeCrateName(value?: string): string | undefined {
  const name = value?.trim().replace(/^crate:/, "").replace(/^std::/, "std").replace(/^core::/, "core")
  if (!name) return undefined
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return undefined
  return name
}

function inferCrateFromPath(query: string): string | undefined {
  const match = query.trim().match(/^([a-z][a-z0-9_]*)(?:::|$)/)
  if (!match?.[1]) return undefined
  return normalizeCrateName(match[1])
}

function stripCratePrefix(query: string, crateName: string): string {
  const normalizedCrate = crateName.replace(/-/g, "_")
  const pattern = new RegExp(`^${escapeRegex(normalizedCrate)}::`, "i")
  return query.replace(pattern, "").trim()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "")
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    hellip: "...",
    mdash: "-",
    ndash: "-",
  }

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return named[entity.toLowerCase()] ?? match
  })
}

function tokenize(value: string): string[] {
  return normalizeToken(value).split(/[^a-z0-9_]+/).filter(token => token.length > 1)
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/::/g, " ").replace(/[^a-z0-9_]+/g, " ").trim()
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function pathToRustdocSource(file: string, anchor?: string): string {
  const normalized = file.replace(/\\/g, "/")
  return `local://${normalized}${anchor ? `#${anchor}` : ""}`
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function dedupeItems(items: RustdocItem[]): RustdocItem[] {
  const seen = new Set<string>()
  const result: RustdocItem[] = []
  for (const item of items) {
    const key = `${item.name}\0${item.file}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}
