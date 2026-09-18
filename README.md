# @pipeworx/grantconnect-au

GrantConnect (Australia) MCP — Commonwealth grant opportunities and grants awarded, from grants.gov.au. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `au_grants_search(query, agency, category, recipient_state, selection_process, min_value, max_value, awarded_from, awarded_to, sort, order, limit, offset)` — awarded grants. Free text is a case-insensitive substring across `recipient_name`, `purpose`, `grant_program`, `grant_activity`; multiple words are AND-ed. Newest first by default, `sort: "value"` ranks by AUD.
- `au_grant_award(ga_id)` — one award in full, **with the linked grant opportunity inlined** when the award records a `go_id`. GrantConnect publishes awards and opportunities as separate reports; this is the join.
- `au_grants_by_recipient(recipient_name | abn, awarded_from, awarded_to, limit, offset)` — every award to one organisation plus the funding total: total AUD, award count, first/last award date, per-agency breakdown. ABN is accepted spaced (`48 008 389 151`) or unspaced.
- `au_grant_opportunities_open(query, agency, category, closing_within_days, limit, offset)` — opportunities whose `close_date` is still in the future, soonest first, with `days_until_close` computed at request time.
- `au_grants_top_recipients(agency, category, recipient_state, awarded_from, awarded_to, limit, scan_limit)` — recipients ranked by total AUD. Reports `rows_scanned`, `total_matching_awards` and `ranking_covers_all_matching_awards`.
- `grantconnect_coverage()` — which reports/date windows are actually loaded, row counts, min/max dates, and any ingest windows in `error`.

## Auth

None.

## Data sources

- GrantConnect — https://www.grants.gov.au (Commonwealth Grants Rules and Guidelines reporting: grant opportunities + grants awarded)

## Gotchas

GrantConnect has no JSON API — it publishes dated report downloads only, which is why `grantconnect_coverage` matters: while the ingest backfills, a year you ask about may simply not be loaded yet, and every tool returns `{ found: false, reason, hint }` rather than an empty-looking answer. Recipient identity is messy at source: names are the legal entity as the recipient typed it (so one organisation appears under several spellings), and `recipient_abn` is published spaced and is blank on some rows — `au_grants_by_recipient` normalises the ABN and reports `matched_recipient_names` so you can see what was actually aggregated. `is_aggregate` rows bundle many small grants into one record (`aggregate_number` says how many), so award counts are not payment counts. Because PostgREST aggregate functions are disabled on this project, `au_grants_top_recipients` ranks from a bounded scan taken largest-award-first and states `rows_scanned` versus `total_matching_awards` — treat a ranking with `ranking_covers_all_matching_awards: false` as a ranking of the big-ticket end, not the whole table. Finally, `close_date` on opportunities carries a real time of day and addenda can move it: `addenda_count > 0` means the notice was amended after publication.

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/grantconnect-au/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Grantconnect Au data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/au_grants_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"homelessness","agency":"Department of Social Services","recipient_state":"ACT","limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/au_grants_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
