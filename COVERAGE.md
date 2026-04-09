# Coverage

This document describes the regulatory content available in this MCP server.

## Data sources

| Source | Coverage | Sourcebook ID |
|---|---|---|
| HCMC (Hellenic Capital Market Commission) — Decisions (Αποφάσεις) | Capital markets supervision decisions | `HCMC_Apofaseis` |
| HCMC — Circulars (Εγκύκλιοι) | Regulatory guidance and interpretations | `HCMC_Egkyklioi` |
| HCMC — Enforcement Actions | Sanctions, fines, bans | _(enforcement_actions table)_ |
| Bank of Greece — Governor's Acts (Πράξεις Διοικητή) | Banking and monetary supervision acts | `BOG_Praxeis_Dioikiti` |
| Bank of Greece — Executive Committee Acts | Systemic risk and resolution decisions | `BOG_Exec_Committee` |

## Regulatory scope

### HCMC (Hellenic Capital Market Commission)

- Investment services and activities (MiFID II transposition — Law 4514/2018)
- Capital market integrity — market abuse, insider trading
- Collective investment undertakings (UCITS, AIFs)
- Public offering prospectuses (Prospectus Regulation)
- Investor compensation schemes
- Short selling restrictions
- AML/CTF obligations for capital market participants

### Bank of Greece

- Prudential supervision of credit institutions (CRD IV / CRR)
- Payment services and electronic money (PSD2)
- AML/CTF for credit institutions and payment service providers
- Resolution measures (BRRD)
- Consumer credit and mortgage credit regulation
- Insurance and private pension supervision (Solvency II)

## Jurisdictional notes

- All content is sourced from official Greek regulatory portals
- Greek-language primary source documents may have English summaries where available
- Coverage reflects publicly available decisions and circulars; confidential supervisory correspondence is excluded
- EU regulations (MiFID II, CRR, GDPR, etc.) that apply directly in Greece are **not** reproduced here — use the relevant EU-law MCP for those

## Data freshness

Data is ingested weekly via the [ingest workflow](.github/workflows/ingest.yml). Check current freshness with the `gr_fin_check_data_freshness` tool.

## Known gaps

- Historical decisions prior to 2010 may have incomplete digital records
- Bank of Greece Governor's Acts prior to 2015 are partially covered
- Enforcement actions database is populated on a best-effort basis from public announcements
- See `data/ingest-state.json` for the current ingestion state

## Not covered

- Greek primary legislation (laws / νόμοι) — use a Greek law MCP for those
- EU-level regulation text — use the EU-law MCP
- Court decisions interpreting these regulations
- ESMA or EBA guidance that has not been adopted by Greek regulators
