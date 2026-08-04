# @pipeworx/grantconnect-au

GrantConnect (Australia) MCP — Commonwealth grant opportunities and grants awarded, from grants.gov.au. Keyless (Pipeworx-hosted).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `au_grants_search(query, agency, category, recipient_state, selection_process, min_value, max_value, awarded_from, awarded_to, sort, order, limit, offset)` — awarded grants. Free text is a case-insensitive substring across `recipient_name`, `purpose`, `grant_program`, `grant_activity`; multiple words are AND-ed. Newest first by default, `sort: "value"` ranks by AUD.
- `au_grant_award(ga_id)` — one award in full, **with the linked grant opportunity inlined** when the award records a `go_id`. GrantConnect publishes awards and opportunities as separate reports; this is the join.
- `au_grants_by_recipient(recipient_name | abn, awarded_from, awarded_to, limit, offset)` — every award to one organisation plus the funding total: total AUD, award count, first/last award date, per-agency breakdown. ABN is accepted spaced (`48 008 389 151`) or unspaced.
- `au_grant_opportunities_open(query, agency, category, closing_within_days, limit, offset)` — opportunities whose `close_date` is still in the future, soonest first, with `days_until_close` computed at request time.
- `au_grants_top_recipients(agency, category, recipient_state, awarded_from, awarded_to, limit, scan_limit)` — recipients ranked by total AUD. Reports `rows_scanned`, `total_matching_awards` and `ranking_covers_all_matching_awards`.
- `grantconnect_coverage()` — which reports/date windows are actually loaded, row counts, min/max dates, and any ingest windows in `error`.

## Auth

None. Pipeworx hosts the data; the gateway injects `_supabaseUrl` / `_supabaseKey`.

## Data sources

- GrantConnect — https://www.grants.gov.au (Commonwealth Grants Rules and Guidelines reporting: grant opportunities + grants awarded)
- Mirrored into Pipeworx Postgres by `workers/grantconnect-ingest`; queried here through PostgREST (`au_grant_awards`, `au_grant_opportunities`, `grantconnect_ingest_state`)

## Gotchas

GrantConnect has no JSON API — it publishes dated report downloads only, which is why this pack reads a Pipeworx mirror rather than the site, and why `grantconnect_coverage` matters: while the ingest backfills, a year you ask about may simply not be loaded yet, and every tool returns `{ found: false, reason, hint }` rather than an empty-looking answer. Recipient identity is messy at source: names are the legal entity as the recipient typed it (so one organisation appears under several spellings), and `recipient_abn` is published spaced and is blank on some rows — `au_grants_by_recipient` normalises the ABN and reports `matched_recipient_names` so you can see what was actually aggregated. `is_aggregate` rows bundle many small grants into one record (`aggregate_number` says how many), so award counts are not payment counts. Because PostgREST aggregate functions are disabled on this project, `au_grants_top_recipients` ranks from a bounded scan taken largest-award-first and states `rows_scanned` versus `total_matching_awards` — treat a ranking with `ranking_covers_all_matching_awards: false` as a ranking of the big-ticket end, not the whole table. Finally, `close_date` on opportunities carries a real time of day and addenda can move it: `addenda_count > 0` means the notice was amended after publication.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "grantconnect-au": {
      "url": "https://gateway.pipeworx.io/grantconnect-au/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Grantconnect Au data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
