# Tools Reference

All tools are prefixed `gr_fin_` and follow the [non-law sector MCP golden standard](https://github.com/Ansvar-Systems/fleet/blob/main/docs/guides/non-law-mcp-golden-standard.md).

## Mandatory tools (golden standard)

| Golden Standard Name | Implemented As | Notes |
|---|---|---|
| `list_sources` | `gr_fin_list_sources` | Alias also available: `gr_fin_list_sourcebooks` |
| `check_data_freshness` | `gr_fin_check_data_freshness` | Reads `data/ingest-state.json` |

## Full tool list

### `gr_fin_search_regulations`

Full-text search across HCMC and Bank of Greece regulatory provisions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query in Greek or English |
| `sourcebook` | string | no | Filter by sourcebook ID (e.g., `HCMC_Apofaseis`) |
| `status` | enum | no | `in_force` \| `deleted` \| `not_yet_in_force` |
| `limit` | number | no | Max results (default 20, max 100) |

Each result includes a `_citation` block for deterministic entity linking.

---

### `gr_fin_get_regulation`

Get a specific provision by sourcebook and reference. Includes `_citation` metadata.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sourcebook` | string | yes | Sourcebook ID (e.g., `HCMC_Apofaseis`, `BOG_Praxeis_Dioikiti`) |
| `reference` | string | yes | Provision reference (e.g., `HCMC_1/452/1.11.2007`) |

---

### `gr_fin_list_sourcebooks`

List all HCMC and Bank of Greece sourcebook categories. See also `gr_fin_list_sources` (golden-standard alias).

No parameters.

---

### `gr_fin_list_sources`

Golden-standard alias for `gr_fin_list_sourcebooks`. Lists all data sources with names and descriptions.

No parameters.

---

### `gr_fin_search_enforcement`

Search enforcement actions — sanctions, fines, activity revocations, and public censures.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query (firm name, breach type, etc.) |
| `action_type` | enum | no | `fine` \| `ban` \| `restriction` \| `warning` |
| `limit` | number | no | Max results (default 20, max 100) |

Each result includes a `_citation` block.

---

### `gr_fin_check_currency`

Check whether a specific provision reference is currently in force.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reference` | string | yes | Provision reference (e.g., `HCMC_1/452/1.11.2007`) |

---

### `gr_fin_check_data_freshness`

Check when data was last ingested and how many records are available. Corresponds to the golden-standard `check_data_freshness` tool.

No parameters.

Returns:

```json
{
  "last_run": "2026-03-23T17:53:27.264Z",
  "provisions_ingested": 0,
  "enforcement_ingested": 0,
  "is_fresh": false,
  "freshness_threshold_days": 7
}
```

---

### `gr_fin_about`

Return server metadata: version, data source URLs, and tool list.

No parameters.

## Response metadata

Every tool response includes a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "This data is provided for informational purposes only...",
    "data_age": "2026-03-23T17:53:27.264Z",
    "copyright": "Data sourced from HCMC and Bank of Greece. All rights reserved.",
    "source_url": "https://www.hcmc.gr/"
  }
}
```

## Error responses

Errors are returned as structured JSON:

```json
{
  "error": "Provision not found: HCMC_Apofaseis NONEXISTENT",
  "_error_type": "tool_error",
  "_meta": { ... }
}
```
