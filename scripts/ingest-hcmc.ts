/**
 * HCMC Ingestion Crawler
 *
 * Scrapes the Hellenic Capital Market Commission website (hcmc.gr) and
 * populates the SQLite database with decisions (apofaseis), circulars
 * (egkyklioi), sanctions, and Bank of Greece Governor's Acts.
 *
 * Data sources:
 *   1. HCMC Decisions       — www.hcmc.gr/en_US/web/portal/elib/decisions
 *   2. HCMC Circulars       — www.hcmc.gr/en_US/web/portal/elib/circulars
 *   3. Sanctions             — www.hcmc.gr/en_US/web/portal/sanctions
 *   4. Laws                  — www.hcmc.gr/en_US/web/portal/elib/lawslaws
 *   5. Ministerial Decisions — www.hcmc.gr/en_US/web/portal/elib/lawsministerial
 *
 * The HCMC site runs on Liferay Portal. Listing pages render document
 * entries inside `<div class="asset-abstract">` or table rows. Pagination
 * is via Liferay's `?cur=N` query parameter. Individual documents may link
 * to detail pages or directly to PDF files under /aweb/files/.
 *
 * Usage:
 *   npx tsx scripts/ingest-hcmc.ts                 # full crawl
 *   npx tsx scripts/ingest-hcmc.ts --resume        # resume from last checkpoint
 *   npx tsx scripts/ingest-hcmc.ts --dry-run       # log what would be inserted
 *   npx tsx scripts/ingest-hcmc.ts --force         # drop and recreate DB first
 *   npx tsx scripts/ingest-hcmc.ts --decisions     # only crawl decisions
 *   npx tsx scripts/ingest-hcmc.ts --circulars     # only crawl circulars
 *   npx tsx scripts/ingest-hcmc.ts --sanctions     # only crawl sanctions
 *   npx tsx scripts/ingest-hcmc.ts --laws          # only crawl laws
 *   npx tsx scripts/ingest-hcmc.ts --max-pages 5   # limit pages per category
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["HCMC_DB_PATH"] ?? "data/hcmc.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://www.hcmc.gr";
const BASE_EN = `${BASE_URL}/en_US/web/portal`;
const BASE_EL = `${BASE_URL}/el_GR/web/portal`;

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 45_000;
const USER_AGENT =
  "AnsvarHCMCCrawler/1.0 (+https://github.com/Ansvar-Systems/greek-financial-regulation-mcp)";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const decisionsOnly = args.includes("--decisions");
const circularsOnly = args.includes("--circulars");
const sanctionsOnly = args.includes("--sanctions");
const lawsOnly = args.includes("--laws");
const filterActive = decisionsOnly || circularsOnly || sanctionsOnly || lawsOnly;

const maxPagesArg = args.find((_, i) => args[i - 1] === "--max-pages");
const maxPagesOverride = maxPagesArg ? parseInt(maxPagesArg, 10) : null;

// ---------------------------------------------------------------------------
// Source definitions — listing pages to crawl
// ---------------------------------------------------------------------------

/**
 * HCMC Liferay portal listing categories.
 *
 * Each category maps to a sourcebook in the database. The listing page
 * renders entries with links to detail pages or PDF downloads. Pagination
 * uses Liferay's `?cur=N` parameter (20 results per page by default).
 */
interface ListingCategory {
  id: string;
  sourcebookId: string;
  pathEn: string;
  pathEl: string;
  docType: string;
  maxPages: number;
  enabled: boolean;
}

const LISTING_CATEGORIES: ListingCategory[] = [
  {
    id: "decisions",
    sourcebookId: "HCMC_APOFASEIS",
    pathEn: "/elib/decisions",
    pathEl: "/elib/decisions",
    docType: "decision",
    maxPages: 50,
    enabled: !filterActive || decisionsOnly,
  },
  {
    id: "circulars",
    sourcebookId: "HCMC_EGKYKLIOI",
    pathEn: "/elib/circulars",
    pathEl: "/elib/circulars",
    docType: "circular",
    maxPages: 30,
    enabled: !filterActive || circularsOnly,
  },
  {
    id: "laws",
    sourcebookId: "HCMC_APOFASEIS",
    pathEn: "/elib/lawslaws",
    pathEl: "/elib/lawslaws",
    docType: "law",
    maxPages: 20,
    enabled: !filterActive || lawsOnly,
  },
  {
    id: "ministerial",
    sourcebookId: "HCMC_APOFASEIS",
    pathEn: "/elib/lawsministerial",
    pathEl: "/elib/lawsministerial",
    docType: "ministerial_decision",
    maxPages: 15,
    enabled: !filterActive || lawsOnly,
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  provisionsIngested: number;
  enforcementIngested: number;
  errors: string[];
}

interface DiscoveredEntry {
  url: string;
  title: string;
  date: string | null;
  reference: string | null;
  pdfUrl: string | null;
  category: ListingCategory;
}

interface ParsedProvision {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

interface ParsedEnforcement {
  firm_name: string;
  reference_number: string | null;
  action_type: string | null;
  amount: number | null;
  date: string | null;
  summary: string | null;
  sourcebook_references: string | null;
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "el,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const state = JSON.parse(raw) as IngestState;
      console.log(
        `Resuming from checkpoint (${state.lastRun}): ` +
          `${state.processedUrls.length} URLs processed, ` +
          `${state.provisionsIngested} provisions, ` +
          `${state.enforcementIngested} enforcement actions`,
      );
      return state;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    provisionsIngested: 0,
    enforcementIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Sourcebook definitions (upserted on every run)
// ---------------------------------------------------------------------------

const SOURCEBOOKS = [
  {
    id: "HCMC_APOFASEIS",
    name: "HCMC Αποφάσεις (Decisions)",
    description:
      "Decisions (apofaseis) of the Hellenic Capital Market Commission governing investment services, capital markets, and securities regulation in Greece.",
  },
  {
    id: "HCMC_EGKYKLIOI",
    name: "HCMC Εγκύκλιοι (Circulars)",
    description:
      "HCMC circulars (egkyklioi) providing interpretive guidance, supervisory expectations, and implementation instructions for regulated entities.",
  },
  {
    id: "BOG_PRAXEIS_DIOIKITI",
    name: "ΤτΕ Πράξεις Διοικητή (Bank of Greece Governor's Acts)",
    description:
      "Executive Acts (Praxeis Dioikiti) issued by the Governor of the Bank of Greece setting prudential requirements for credit institutions and payment service providers.",
  },
  {
    id: "HCMC_NOMOI",
    name: "Νόμοι (Laws)",
    description:
      "Greek laws (nomoi) governing capital markets, investment services, and financial regulation as published in the Government Gazette.",
  },
];

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from an HTML string, collapsing whitespace.
 */
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return $.text().replace(/\s+/g, " ").trim();
}

/**
 * Try to extract a date from Greek or English text.
 * Handles formats like:
 *   - "14/07/2016" or "14.07.2016" (European numeric)
 *   - "14 Ιουλίου 2016" (Greek month names)
 *   - "14 July 2016" (English month names)
 *   - "2016-07-14" (ISO)
 */
function extractDate(text: string): string | null {
  // ISO format
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // European numeric (DD/MM/YYYY or DD.MM.YYYY)
  const euMatch = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (euMatch) {
    const day = euMatch[1]!.padStart(2, "0");
    const month = euMatch[2]!.padStart(2, "0");
    return `${euMatch[3]}-${month}-${day}`;
  }

  // Greek month names
  const greekMonths: Record<string, string> = {
    Ιανουαρίου: "01", Φεβρουαρίου: "02", Μαρτίου: "03",
    Απριλίου: "04", Μαΐου: "05", Ιουνίου: "06",
    Ιουλίου: "07", Αυγούστου: "08", Σεπτεμβρίου: "09",
    Οκτωβρίου: "10", Νοεμβρίου: "11", Δεκεμβρίου: "12",
    Ιανουάριος: "01", Φεβρουάριος: "02", Μάρτιος: "03",
    Απρίλιος: "04", Μάιος: "05", Ιούνιος: "06",
    Ιούλιος: "07", Αύγουστος: "08", Σεπτέμβριος: "09",
    Οκτώβριος: "10", Νοέμβριος: "11", Δεκέμβριος: "12",
  };

  for (const [name, num] of Object.entries(greekMonths)) {
    const re = new RegExp(`(\\d{1,2})\\s+${name}\\s+(\\d{4})`);
    const m = text.match(re);
    if (m) {
      const day = m[1]!.padStart(2, "0");
      return `${m[2]}-${num}-${day}`;
    }
  }

  // English month names
  const enMonths: Record<string, string> = {
    January: "01", February: "02", March: "03", April: "04",
    May: "05", June: "06", July: "07", August: "08",
    September: "09", October: "10", November: "11", December: "12",
  };

  for (const [name, num] of Object.entries(enMonths)) {
    const re = new RegExp(`(\\d{1,2})\\s+${name}\\s+(\\d{4})`, "i");
    const m = text.match(re);
    if (m) {
      const day = m[1]!.padStart(2, "0");
      return `${m[2]}-${num}-${day}`;
    }
    // Also match "Month DD, YYYY"
    const re2 = new RegExp(`${name}\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i");
    const m2 = text.match(re2);
    if (m2) {
      const day = m2[1]!.padStart(2, "0");
      return `${m2[2]}-${num}-${day}`;
    }
  }

  return null;
}

/**
 * Extract a reference number from a decision/circular title or text.
 *
 * HCMC uses several reference formats:
 *   - "Απόφαση 1/452/1.11.2007"     → "HCMC_1/452/1.11.2007"
 *   - "Εγκύκλιος 54"                 → "HCMC_EG_54"
 *   - "N. 4514/2018"                 → "LAW_4514/2018"
 *   - "ΥΑ 12345/2020"               → "MD_12345/2020"
 */
function extractReference(title: string, docType: string): string {
  // HCMC decision pattern: number/number/date
  const decisionMatch = title.match(
    /(?:Απόφαση|Decision|Απ\.?)\s*(\d+\/\d+\/[\d.]+)/i,
  );
  if (decisionMatch) {
    return `HCMC_${decisionMatch[1]}`;
  }

  // Standalone numeric reference like "1/452/1.11.2007"
  const numericRef = title.match(/(\d+\/\d+\/\d{1,2}\.\d{1,2}\.\d{4})/);
  if (numericRef) {
    return `HCMC_${numericRef[1]}`;
  }

  // Circular pattern
  const circularMatch = title.match(
    /(?:Εγκύκλιος|Circular|Εγκ\.?)\s*(?:αρ\.?\s*)?(\d+)/i,
  );
  if (circularMatch) {
    return `HCMC_EG_${circularMatch[1]}`;
  }

  // Law pattern: N. or Ν. or Law followed by number/year
  const lawMatch = title.match(
    /(?:Ν\.|N\.|Νόμος|Law)\s*(\d+)\/(\d{4})/i,
  );
  if (lawMatch) {
    return `LAW_${lawMatch[1]}/${lawMatch[2]}`;
  }

  // Ministerial decision
  const mdMatch = title.match(
    /(?:ΥΑ|Υπουργική\s+Απόφαση|Ministerial\s+Decision)\s*(\d+)/i,
  );
  if (mdMatch) {
    return `MD_${mdMatch[1]}`;
  }

  // Presidential decree
  const pdMatch = title.match(
    /(?:ΠΔ|Π\.?Δ\.?|Presidential\s+Decree)\s*(\d+)\/(\d{4})/i,
  );
  if (pdMatch) {
    return `PD_${pdMatch[1]}/${pdMatch[2]}`;
  }

  // Bank of Greece Governor's Act
  const bogMatch = title.match(
    /(?:Πράξη\s+Διοικητή|Governor'?s?\s+Act|Executive\s+Act|ΠΔ\/ΤΕ|ΠΔΤΕ)\s*(\d+)/i,
  );
  if (bogMatch) {
    return `BOG_EXEC_${bogMatch[1]}`;
  }

  // Fallback: generate a reference from the document type and a slug of the title
  const slug = title
    .replace(/[^\w\sα-ωΑ-Ω]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
  const prefix =
    docType === "circular"
      ? "HCMC_EG"
      : docType === "law"
        ? "LAW"
        : docType === "ministerial_decision"
          ? "MD"
          : "HCMC";
  return `${prefix}_${slug}`;
}

/**
 * Try to classify the enforcement action type from Greek/English text.
 */
function classifyEnforcementType(text: string): string {
  const lower = text.toLowerCase();
  const lowerGr = text;

  if (
    /πρόστιμο|fine|χρηματικ|monetary\s+penalty/i.test(lowerGr)
  ) {
    return "fine";
  }
  if (
    /ανάκληση\s+άδειας|license\s+revocation|withdrawal.*licen/i.test(lowerGr)
  ) {
    return "license_revocation";
  }
  if (
    /αναστολή|suspension|suspend/i.test(lowerGr)
  ) {
    return "suspension";
  }
  if (
    /προειδοποίηση|warning|reprimand|επίπληξη/i.test(lowerGr)
  ) {
    return "warning";
  }
  if (
    /περιορισμός|restriction|restrict/i.test(lowerGr)
  ) {
    return "restriction";
  }
  if (
    /απαγόρευση|prohibition|prohibit/i.test(lower)
  ) {
    return "prohibition";
  }

  return "other";
}

/**
 * Try to extract a fine amount (EUR) from text.
 */
function extractFineAmount(text: string): number | null {
  // Match patterns like "EUR 350,000" or "€350.000" or "350.000 ευρώ"
  const patterns = [
    /(?:EUR|€)\s*([\d.,]+)/i,
    /([\d.,]+)\s*(?:ευρώ|euro|EUR|€)/i,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      // Handle both "350,000" and "350.000" as thousands separators
      const cleaned = m[1]!
        .replace(/\./g, "")  // Remove dots (Greek thousands separator)
        .replace(/,/g, "");  // Remove commas (English thousands separator)
      const amount = parseFloat(cleaned);
      if (!isNaN(amount) && amount > 0) {
        return amount;
      }
    }
  }

  return null;
}

/**
 * Resolve a potentially relative URL to an absolute URL.
 */
function resolveUrl(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  if (href.startsWith("//")) {
    return `https:${href}`;
  }
  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }
  return `${BASE_URL}/${href}`;
}

// ---------------------------------------------------------------------------
// Listing page crawling — discover document entries
// ---------------------------------------------------------------------------

/**
 * Crawl paginated listing pages to discover document entries.
 *
 * The HCMC Liferay portal uses several HTML patterns for listing content:
 *   - Asset Publisher portlets with `<div class="asset-abstract">`
 *   - Tables with `<tr>` entries containing title links
 *   - Journal article lists with `<div class="journal-content-article">`
 *
 * Pagination uses Liferay's `?cur=N` parameter (default 20 per page).
 * Some pages use `?delta=N&cur=N` or `?start=N`.
 */
async function discoverEntries(
  category: ListingCategory,
): Promise<DiscoveredEntry[]> {
  const entries: DiscoveredEntry[] = [];
  const seenUrls = new Set<string>();
  const effectiveMax = maxPagesOverride
    ? Math.min(maxPagesOverride, category.maxPages)
    : category.maxPages;

  console.log(
    `\n  Discovering entries from ${category.id} (up to ${effectiveMax} pages)...`,
  );

  for (let page = 1; page <= effectiveMax; page++) {
    // Liferay pagination: ?cur=1 is first page
    const listUrl =
      page === 1
        ? `${BASE_EN}${category.pathEn}`
        : `${BASE_EN}${category.pathEn}?cur=${page}`;

    if (page % 5 === 1 || page === 1) {
      console.log(
        `    Fetching listing page ${page}/${effectiveMax}... (${entries.length} entries so far)`,
      );
    }

    const html = await rateLimitedFetch(listUrl);
    if (!html) {
      console.warn(`    [WARN] Could not fetch listing page ${page}`);
      continue;
    }

    const $ = cheerio.load(html);
    let pageEntries = 0;

    // Strategy 1: Liferay Asset Publisher entries
    // These appear as <div class="asset-abstract"> or <div class="asset-full-content">
    $(".asset-abstract, .asset-full-content, .journal-content-article").each(
      (_i, el) => {
        const $el = $(el);
        const $link = $el.find("a[href]").first();
        const href = $link.attr("href");
        const title = $link.text().trim() || $el.find("h3, h4, .asset-title").text().trim();

        if (!href || !title || seenUrls.has(href)) return;

        const fullUrl = resolveUrl(href);
        seenUrls.add(href);

        const dateText = $el.find(".asset-date, .metadata-entry, .modified-date, time").text();
        const pdfLink = $el.find('a[href$=".pdf"]').attr("href");

        entries.push({
          url: fullUrl,
          title,
          date: extractDate(dateText || title),
          reference: null,
          pdfUrl: pdfLink ? resolveUrl(pdfLink) : null,
          category,
        });
        pageEntries++;
      },
    );

    // Strategy 2: Table-based listings
    if (pageEntries === 0) {
      $("table tbody tr, table tr").each((_i, el) => {
        const $row = $(el);
        const $link = $row.find("a[href]").first();
        const href = $link.attr("href");
        if (!href || seenUrls.has(href)) return;

        const cells = $row.find("td");
        const title =
          $link.text().trim() ||
          cells.first().text().trim();

        if (!title) return;

        const fullUrl = resolveUrl(href);
        seenUrls.add(href);

        // Date is often in the second or third cell
        let dateStr: string | null = null;
        cells.each((_j, cell) => {
          if (!dateStr) {
            dateStr = extractDate($(cell).text());
          }
        });

        const pdfLink = $row.find('a[href$=".pdf"]').attr("href");

        entries.push({
          url: fullUrl,
          title,
          date: dateStr,
          reference: null,
          pdfUrl: pdfLink ? resolveUrl(pdfLink) : null,
          category,
        });
        pageEntries++;
      });
    }

    // Strategy 3: Generic link-based listings (linked headings, divs with anchors)
    if (pageEntries === 0) {
      $(
        ".portlet-body a[href], .portlet-content a[href], #main-content a[href]",
      ).each((_i, el) => {
        const $link = $(el);
        const href = $link.attr("href");
        if (!href || seenUrls.has(href)) return;

        // Skip navigation, pagination, and external links
        if (
          href.includes("?cur=") ||
          href.includes("#") ||
          href.includes("javascript:") ||
          href.includes("mailto:") ||
          href.startsWith("http") && !href.includes("hcmc.gr")
        ) {
          return;
        }

        const title = $link.text().trim();
        if (!title || title.length < 5) return;

        const fullUrl = resolveUrl(href);
        seenUrls.add(href);

        entries.push({
          url: fullUrl,
          title,
          date: extractDate(title),
          reference: null,
          pdfUrl: href.endsWith(".pdf") ? fullUrl : null,
          category,
        });
        pageEntries++;
      });
    }

    // Stop if this page had zero results (past the last page)
    if (pageEntries === 0 && page > 1) {
      console.log(
        `    Page ${page} returned 0 entries, stopping pagination for ${category.id}`,
      );
      break;
    }
  }

  console.log(`    Discovered ${entries.length} entries for ${category.id}`);
  return entries;
}

// ---------------------------------------------------------------------------
// Detail page parsing
// ---------------------------------------------------------------------------

/**
 * Fetch and parse a detail page for a decision, circular, or law.
 *
 * HCMC detail pages typically have:
 *   - Title in <h1>, <h2>, or `.journal-content-article h3`
 *   - Body text in `.journal-content-article`, `.asset-content`, or `<article>`
 *   - Metadata (date, reference) in the page header or a metadata block
 *   - Links to PDF files with the official text
 */
async function parseDetailPage(
  entry: DiscoveredEntry,
): Promise<ParsedProvision | null> {
  // If the URL points directly to a PDF, we cannot parse HTML
  if (entry.url.endsWith(".pdf")) {
    return {
      sourcebook_id: entry.category.sourcebookId,
      reference: extractReference(entry.title, entry.category.docType),
      title: entry.title,
      text: `[PDF document] ${entry.title}. Source: ${entry.url}`,
      type: entry.category.docType,
      status: "in_force",
      effective_date: entry.date,
      chapter: null,
      section: null,
    };
  }

  const html = await rateLimitedFetch(entry.url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // Extract title — try multiple selectors
  let title =
    $("h1.header-title").text().trim() ||
    $("h1").first().text().trim() ||
    $(".journal-content-article h3").first().text().trim() ||
    $(".asset-title").first().text().trim() ||
    entry.title;

  // Clean up the title
  title = title.replace(/\s+/g, " ").trim();

  // Extract body text from the main content area
  let bodyHtml =
    $(".journal-content-article").html() ||
    $(".asset-content").html() ||
    $("article").html() ||
    $(".portlet-body").html() ||
    $("#main-content").html() ||
    "";

  const bodyText = htmlToText(bodyHtml || "");

  // If body is too short, use the entire page content
  const text = bodyText.length > 50 ? bodyText : htmlToText($.html() || "");

  if (text.length < 20) {
    return null;
  }

  // Extract date from the page content
  const pageDateText =
    $(".asset-date, .metadata-entry, .modified-date, time").text() ||
    $('meta[name="DC.date"]').attr("content") ||
    "";
  const effectiveDate =
    entry.date || extractDate(pageDateText) || extractDate(title) || extractDate(text.slice(0, 500));

  // Build reference
  const reference =
    entry.reference || extractReference(title, entry.category.docType);

  // Try to extract chapter/section from the content structure
  let chapter: string | null = null;
  let section: string | null = null;
  const chapterMatch = text.match(
    /(?:Κεφάλαιο|Chapter|ΚΕΦΑΛΑΙΟ)\s+([Α-ΩA-Z0-9]+)/i,
  );
  if (chapterMatch) {
    chapter = chapterMatch[1] ?? null;
  }
  const sectionMatch = text.match(
    /(?:Άρθρο|Article|ΑΡΘΡΟ)\s+(\d+)/i,
  );
  if (sectionMatch) {
    section = sectionMatch[1] ?? null;
  }

  // Check if the document is repealed/amended
  let status = "in_force";
  if (
    /καταργ|repealed|revoked|ακυρ/i.test(text.slice(0, 1000))
  ) {
    status = "repealed";
  } else if (
    /τροποποι|amended|modified/i.test(text.slice(0, 1000))
  ) {
    status = "amended";
  }

  return {
    sourcebook_id: entry.category.sourcebookId,
    reference,
    title,
    text: text.slice(0, 50_000), // Limit text size
    type: entry.category.docType,
    status,
    effective_date: effectiveDate,
    chapter,
    section,
  };
}

// ---------------------------------------------------------------------------
// Sanctions crawling
// ---------------------------------------------------------------------------

/**
 * Crawl the HCMC sanctions page and extract enforcement actions.
 *
 * The sanctions page at /en_US/web/portal/sanctions lists enforcement
 * actions in a table or structured list. Each entry contains the firm name,
 * sanction type, amount, and date.
 */
async function crawlSanctions(): Promise<ParsedEnforcement[]> {
  console.log("\n  Crawling sanctions...");
  const results: ParsedEnforcement[] = [];

  // Try both English and Greek sanctions pages
  const sanctionUrls = [
    `${BASE_EN}/sanctions`,
    `${BASE_EL}/sanctions`,
  ];

  for (const pageUrl of sanctionUrls) {
    // Paginate through sanctions
    for (let page = 1; page <= 20; page++) {
      const url = page === 1 ? pageUrl : `${pageUrl}?cur=${page}`;
      const html = await rateLimitedFetch(url);
      if (!html) continue;

      const $ = cheerio.load(html);
      let pageResults = 0;

      // Strategy 1: Table-based sanctions listing
      $("table tbody tr, table tr").each((_i, el) => {
        const $row = $(el);
        const cells = $row.find("td");
        if (cells.length < 2) return;

        const rowText = $row.text();
        const firmName = cells.eq(0).text().trim();
        if (!firmName || firmName.length < 2) return;

        // Skip header rows
        if (
          /εταιρ[ιε]ία|firm|company|entity|επωνυμ/i.test(firmName) &&
          cells.length < 4
        ) {
          return;
        }

        const enforcement: ParsedEnforcement = {
          firm_name: firmName,
          reference_number: null,
          action_type: classifyEnforcementType(rowText),
          amount: extractFineAmount(rowText),
          date: extractDate(rowText),
          summary: cells
            .map((_j, c) => $(c).text().trim())
            .get()
            .filter((t) => t.length > 0)
            .join(" — "),
          sourcebook_references: null,
        };

        results.push(enforcement);
        pageResults++;
      });

      // Strategy 2: Asset Publisher listing of sanction entries
      if (pageResults === 0) {
        $(".asset-abstract, .journal-content-article").each((_i, el) => {
          const $el = $(el);
          const text = $el.text();
          const title =
            $el.find("h3, h4, .asset-title, a").first().text().trim();

          if (!title || title.length < 5) return;

          // Try to extract firm name from title
          // Common pattern: "Penalty on [firm name] for [violation]"
          const firmMatch = title.match(
            /(?:on|against|κατά|στην?|στο)\s+(.+?)(?:\s+for|\s+για|\s*$)/i,
          );
          const firmName = firmMatch ? firmMatch[1]!.trim() : title;

          const enforcement: ParsedEnforcement = {
            firm_name: firmName,
            reference_number: null,
            action_type: classifyEnforcementType(text),
            amount: extractFineAmount(text),
            date: extractDate(text),
            summary: text.replace(/\s+/g, " ").trim().slice(0, 2000),
            sourcebook_references: null,
          };

          results.push(enforcement);
          pageResults++;
        });
      }

      // Strategy 3: Linked list of sanction detail pages
      if (pageResults === 0) {
        const detailLinks: string[] = [];
        $("a[href]").each((_i, el) => {
          const href = $(el).attr("href");
          if (
            href &&
            !href.includes("?cur=") &&
            !href.includes("#") &&
            (href.includes("sanction") || href.includes("penalty") ||
              href.includes("πρόστιμο") || href.includes("κύρωση"))
          ) {
            detailLinks.push(resolveUrl(href));
          }
        });

        for (const detailUrl of detailLinks.slice(0, 50)) {
          const detailHtml = await rateLimitedFetch(detailUrl);
          if (!detailHtml) continue;

          const $detail = cheerio.load(detailHtml);
          const detailText = htmlToText($detail.html() || "");
          const detailTitle =
            $detail("h1").first().text().trim() ||
            $detail(".asset-title").first().text().trim();

          if (detailText.length < 30) continue;

          const firmMatch = detailText.match(
            /(?:on|against|κατά|στην?|στο)\s+["«]?(.+?)["»]?\s+(?:for|για|due|λόγω)/i,
          );

          results.push({
            firm_name: firmMatch ? firmMatch[1]!.trim() : detailTitle,
            reference_number: null,
            action_type: classifyEnforcementType(detailText),
            amount: extractFineAmount(detailText),
            date: extractDate(detailText.slice(0, 500)),
            summary: detailText.slice(0, 2000),
            sourcebook_references: null,
          });
          pageResults++;
        }
      }

      if (pageResults === 0 && page > 1) {
        break;
      }
    }
  }

  console.log(`    Discovered ${results.length} enforcement actions`);
  return results;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  console.log(`Database initialised at ${DB_PATH}`);
  return db;
}

function upsertSourcebooks(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const sb of SOURCEBOOKS) {
      stmt.run(sb.id, sb.name, sb.description);
    }
  });
  tx();
  console.log(`Upserted ${SOURCEBOOKS.length} sourcebooks`);
}

function insertProvision(
  db: Database.Database,
  p: ParsedProvision,
): boolean {
  // Check for duplicates by reference
  const existing = db
    .prepare(
      "SELECT id FROM provisions WHERE sourcebook_id = ? AND reference = ?",
    )
    .get(p.sourcebook_id, p.reference) as { id: number } | undefined;

  if (existing) {
    // Update existing record if we have more text
    const existingText = db
      .prepare("SELECT text FROM provisions WHERE id = ?")
      .get(existing.id) as { text: string } | undefined;

    if (existingText && p.text.length > existingText.text.length) {
      db.prepare(
        `UPDATE provisions
         SET title = ?, text = ?, type = ?, status = ?,
             effective_date = ?, chapter = ?, section = ?
         WHERE id = ?`,
      ).run(
        p.title,
        p.text,
        p.type,
        p.status,
        p.effective_date,
        p.chapter,
        p.section,
        existing.id,
      );
      return true;
    }
    return false;
  }

  db.prepare(
    `INSERT INTO provisions
       (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.sourcebook_id,
    p.reference,
    p.title,
    p.text,
    p.type,
    p.status,
    p.effective_date,
    p.chapter,
    p.section,
  );
  return true;
}

function insertEnforcement(
  db: Database.Database,
  e: ParsedEnforcement,
): boolean {
  // Deduplicate by firm name + date
  const existing = db
    .prepare(
      "SELECT id FROM enforcement_actions WHERE firm_name = ? AND date = ?",
    )
    .get(e.firm_name, e.date) as { id: number } | undefined;

  if (existing) return false;

  db.prepare(
    `INSERT INTO enforcement_actions
       (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.firm_name,
    e.reference_number,
    e.action_type,
    e.amount,
    e.date,
    e.summary,
    e.sourcebook_references,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Main crawl orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== HCMC Ingestion Crawler ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Rate limit: ${RATE_LIMIT_MS}ms between requests`);
  console.log();

  const state = loadState();
  const db = dryRun ? null : initDatabase();

  if (db) {
    upsertSourcebooks(db);
  }

  // -----------------------------------------------------------------------
  // Phase 1: Crawl provision listings (decisions, circulars, laws)
  // -----------------------------------------------------------------------

  const enabledCategories = LISTING_CATEGORIES.filter((c) => c.enabled);

  for (const category of enabledCategories) {
    console.log(`\n--- ${category.id.toUpperCase()} ---`);

    const entries = await discoverEntries(category);
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const entry of entries) {
      // Skip already-processed URLs when resuming
      if (state.processedUrls.includes(entry.url)) {
        skipped++;
        continue;
      }

      try {
        const provision = await parseDetailPage(entry);
        if (!provision) {
          skipped++;
          state.processedUrls.push(entry.url);
          continue;
        }

        if (dryRun) {
          console.log(
            `  [DRY RUN] Would insert: ${provision.reference} — ${provision.title.slice(0, 80)}`,
          );
          inserted++;
        } else if (db) {
          const wasInserted = insertProvision(db, provision);
          if (wasInserted) {
            inserted++;
            state.provisionsIngested++;
          } else {
            skipped++;
          }
        }

        state.processedUrls.push(entry.url);

        // Save state periodically
        if ((inserted + skipped) % 20 === 0) {
          saveState(state);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [ERROR] Failed to process ${entry.url}: ${message}`);
        state.errors.push(`${entry.url}: ${message}`);
        errors++;
      }
    }

    console.log(
      `  ${category.id}: ${inserted} inserted, ${skipped} skipped, ${errors} errors`,
    );
    saveState(state);
  }

  // -----------------------------------------------------------------------
  // Phase 2: Crawl sanctions / enforcement actions
  // -----------------------------------------------------------------------

  if (!filterActive || sanctionsOnly) {
    console.log("\n--- SANCTIONS ---");

    const enforcements = await crawlSanctions();
    let inserted = 0;
    let skipped = 0;

    for (const e of enforcements) {
      if (dryRun) {
        console.log(
          `  [DRY RUN] Would insert enforcement: ${e.firm_name} — ${e.action_type} — ${e.amount ?? "N/A"}`,
        );
        inserted++;
      } else if (db) {
        const wasInserted = insertEnforcement(db, e);
        if (wasInserted) {
          inserted++;
          state.enforcementIngested++;
        } else {
          skipped++;
        }
      }
    }

    console.log(`  Sanctions: ${inserted} inserted, ${skipped} skipped`);
    saveState(state);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  console.log("\n=== Crawl Complete ===");

  if (db) {
    const provisionCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as {
        cnt: number;
      }
    ).cnt;
    const sourcebookCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as {
        cnt: number;
      }
    ).cnt;
    const enforcementCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
        cnt: number;
      }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as {
        cnt: number;
      }
    ).cnt;

    console.log(`\nDatabase summary:`);
    console.log(`  Sourcebooks:          ${sourcebookCount}`);
    console.log(`  Provisions:           ${provisionCount}`);
    console.log(`  Enforcement actions:  ${enforcementCount}`);
    console.log(`  FTS entries:          ${ftsCount}`);

    db.close();
  }

  console.log(`\nState: ${state.processedUrls.length} URLs processed`);
  console.log(
    `  Provisions ingested: ${state.provisionsIngested}`,
  );
  console.log(
    `  Enforcement ingested: ${state.enforcementIngested}`,
  );

  if (state.errors.length > 0) {
    console.log(`  Errors: ${state.errors.length}`);
    for (const err of state.errors.slice(-10)) {
      console.log(`    - ${err}`);
    }
  }

  saveState(state);
  console.log(`\nDone. State saved to ${STATE_FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
