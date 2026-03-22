/**
 * Seed the HCMC / Bank of Greece database with sample provisions for testing.
 *
 * Inserts representative provisions from HCMC decisions, circulars,
 * and Bank of Greece Governor's Acts so MCP tools can be tested without a full crawl.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["HCMC_DB_PATH"] ?? "data/hcmc.db";
const force = process.argv.includes("--force");

// -- Bootstrap database --

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

// -- Sourcebooks --

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
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
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// -- Sample provisions --

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // -- HCMC_APOFASEIS — HCMC Decisions --
  {
    sourcebook_id: "HCMC_APOFASEIS",
    reference: "HCMC_1/452/1.11.2007",
    title: "Απόφαση HCMC για υπηρεσίες επενδύσεων (Decision on Investment Services)",
    text: "The HCMC Decision 1/452/1.11.2007 sets out detailed requirements for investment firms providing investment services and ancillary services in Greece, implementing MiFID I. Firms must maintain organisational arrangements, conflict of interest policies, client classification procedures, and best execution policies. Client assets must be segregated from firm assets at all times.",
    type: "decision",
    status: "in_force",
    effective_date: "2007-11-01",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "HCMC_APOFASEIS",
    reference: "HCMC_2/584/20.4.2011",
    title: "Απόφαση HCMC για προτυποποιημένες πληροφορίες (Standardised Information Decision)",
    text: "HCMC Decision 2/584/20.4.2011 requires investment firms to provide standardised pre-sale information to retail clients. The decision specifies the format and content of key information documents (KID) for complex financial instruments, disclosure of costs and charges, and the appropriateness assessment procedure for execution-only services.",
    type: "decision",
    status: "in_force",
    effective_date: "2011-04-20",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "HCMC_APOFASEIS",
    reference: "HCMC_5/823/14.7.2016",
    title: "Απόφαση για κατάχρηση αγοράς (Market Abuse Decision)",
    text: "HCMC Decision 5/823/14.7.2016 implements the Market Abuse Regulation (MAR, EU 596/2014) requirements for issuers and investment firms. Issuers must publish insider information promptly, maintain insider lists, and implement market soundings procedures. Investment firms must report suspicious transactions and orders (STORs) to the HCMC without delay.",
    type: "decision",
    status: "in_force",
    effective_date: "2016-07-14",
    chapter: "3",
    section: "3.1",
  },
  {
    sourcebook_id: "HCMC_APOFASEIS",
    reference: "HCMC_3/732/18.11.2014",
    title: "Απόφαση για διαχείριση επενδυτικών κεφαλαίων (UCITS / AIFMD Decision)",
    text: "This HCMC decision sets organisational requirements for UCITS management companies and alternative investment fund managers (AIFMs) operating in Greece. Requirements cover internal controls, risk management, liquidity management, depositary arrangements, and periodic reporting to the HCMC. AIFMs above the AIFMD threshold must obtain HCMC authorisation.",
    type: "decision",
    status: "in_force",
    effective_date: "2014-11-18",
    chapter: "4",
    section: "4.1",
  },
  // -- HCMC_EGKYKLIOI — HCMC Circulars --
  {
    sourcebook_id: "HCMC_EGKYKLIOI",
    reference: "HCMC_EG_2023_01",
    title: "Εγκύκλιος για εφαρμογή MiFID II (MiFID II Implementation Circular)",
    text: "The HCMC circular provides interpretive guidance on the application of MiFID II requirements in Greece, including the suitability and appropriateness assessments for investment advice and execution-only services. Investment firms must document suitability reports for each recommendation, taking into account client knowledge, experience, financial situation, and investment objectives.",
    type: "circular",
    status: "in_force",
    effective_date: "2023-03-15",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "HCMC_EGKYKLIOI",
    reference: "HCMC_EG_2023_02",
    title: "Εγκύκλιος για κρυπτοστοιχεία και MiCA (Crypto-assets and MiCA Circular)",
    text: "HCMC circular informing market participants of the application of the Markets in Crypto-Assets Regulation (MiCA, EU 2023/1114) in Greece from 30 December 2024. Crypto-asset service providers (CASPs) must apply for HCMC authorisation under MiCA. Existing CASP registrations under national law do not automatically extend to MiCA authorisation.",
    type: "circular",
    status: "in_force",
    effective_date: "2023-09-01",
    chapter: "2",
    section: "2.1",
  },
  // -- BOG_PRAXEIS_DIOIKITI — Bank of Greece Governor's Acts --
  {
    sourcebook_id: "BOG_PRAXEIS_DIOIKITI",
    reference: "BOG_EXEC_2577_2006",
    title: "Πράξη Διοικητή για επιχειρησιακό κίνδυνο (Operational Risk Executive Act)",
    text: "Bank of Greece Executive Act 2577/2006 sets out requirements for the management of operational risk in credit institutions, implementing the Basel II framework. Credit institutions must apply either the Basic Indicator Approach, the Standardised Approach, or Advanced Measurement Approaches for calculating operational risk capital requirements. Internal loss event data collection is mandatory.",
    type: "governors_act",
    status: "in_force",
    effective_date: "2006-03-09",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "BOG_PRAXEIS_DIOIKITI",
    reference: "BOG_EXEC_273_1_2021",
    title: "Πράξη Διοικητή για ICT και λειτουργικές ανθεκτικότητα (ICT and Operational Resilience Act)",
    text: "Bank of Greece Executive Act 273/1/21.10.2021 sets requirements for ICT risk management and operational resilience for credit institutions and payment institutions. Institutions must maintain documented ICT risk management frameworks, business continuity plans, and ICT incident reporting procedures. Third-party ICT service provider risk must be managed through appropriate contractual and monitoring arrangements.",
    type: "governors_act",
    status: "in_force",
    effective_date: "2021-10-21",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "BOG_PRAXEIS_DIOIKITI",
    reference: "BOG_EXEC_256_2_2024",
    title: "Πράξη Διοικητή για εφαρμογή DORA (DORA Implementation Act)",
    text: "Bank of Greece Executive Act 256/2/2024 provides guidance on national implementation of the Digital Operational Resilience Act (DORA, EU 2022/2554) for Greek credit institutions and payment service providers. Entities must complete their ICT risk management framework alignment, establish threat-led penetration testing programmes, and register critical third-party ICT providers by 17 January 2025.",
    type: "governors_act",
    status: "in_force",
    effective_date: "2024-01-15",
    chapter: "3",
    section: "3.1",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
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
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

// -- Sample enforcement actions --

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Piraeus Securities SA",
    reference_number: "HCMC_ENF_2023_018",
    action_type: "fine",
    amount: 350_000,
    date: "2023-05-12",
    summary:
      "HCMC imposed a EUR 350,000 administrative sanction on Piraeus Securities SA for failures in its suitability assessment process. The firm had systematically recommended complex structured products to retail clients without conducting adequate assessments of their knowledge, experience, and risk tolerance as required under MiFID II and HCMC Decision 1/452/1.11.2007.",
    sourcebook_references: "HCMC_1/452/1.11.2007, HCMC_EG_2023_01",
  },
  {
    firm_name: "Alpha Finance ΑΕΠΕΥ",
    reference_number: "HCMC_ENF_2022_007",
    action_type: "restriction",
    amount: 180_000,
    date: "2022-11-30",
    summary:
      "HCMC imposed sanctions on Alpha Finance AEPEY for breaches of market abuse prevention obligations under MAR. The firm failed to establish adequate surveillance systems to detect suspicious trading patterns and did not file required Suspicious Transaction and Order Reports (STORs) for three identified cases of potential market manipulation.",
    sourcebook_references: "HCMC_5/823/14.7.2016",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// -- Summary --

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
