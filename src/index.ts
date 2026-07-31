interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * GrantConnect (Australia) MCP — Commonwealth grant opportunities and grants
 * awarded, from grants.gov.au. GrantConnect publishes no JSON API (only dated
 * CSV/report downloads), so Pipeworx ingests it into its own Postgres
 * (workers/grantconnect-ingest) and this pack queries that store via PostgREST.
 *
 * Two tables:
 *   au_grant_awards        — one row per awarded grant (PK ga_id, joins to go_id)
 *   au_grant_opportunities — one row per grant opportunity (PK go_id)
 *
 * The distinctive capability is the award -> opportunity join: GrantConnect
 * publishes the two as separate reports, so "which advertised call produced this
 * payment" normally requires stitching them together by hand.
 *
 * The pack is stateless (the gateway handles auth + rate limiting) and never
 * throws for an expected-empty result — it returns { found: false, reason, hint }.
 */


const AWARDS_TABLE = 'au_grant_awards';
const OPPS_TABLE = 'au_grant_opportunities';
const INGEST_TABLE = 'grantconnect_ingest_state';

// Free-text is matched across these award columns (all trigram-indexed except
// the two program columns, which are short enough to scan behind other filters).
const AWARD_TEXT_COLUMNS = ['recipient_name', 'purpose', 'grant_program', 'grant_activity'];

const tools: McpToolExport['tools'] = [
  {
    name: 'au_grants_search',
    description:
      'Search awarded Australian Commonwealth government grants from GrantConnect (grants.gov.au) — every grant a federal agency has paid out, with recipient organisation, funding agency, grant program and activity, value in AUD, approval and start/end dates, recipient state and suburb, selection process, and the go_id of the opportunity it was awarded under. Free-text query is matched as a case-insensitive substring across recipient_name, purpose, grant_program and grant_activity. Filter by agency (substring, e.g. "Department of Social Services"), category (e.g. "Social Inclusion"), recipient_state (ACT, NSW, VIC, QLD, SA, WA, TAS, NT), selection_process (e.g. "Open Competitive", "Demand Driven"), min_value/max_value in AUD, and an awarded_from/awarded_to date range on the publish date. Answers "who received Australian federal grant money for X, how much, and when". Sort by value or date; newest first by default.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free text, matched case-insensitively as a substring against recipient_name, purpose, grant_program and grant_activity. Multiple words are AND-ed, e.g. "youth homelessness".',
        },
        agency: {
          type: 'string',
          description: 'Funding agency, substring match, e.g. "Social Services", "Department of Health".',
        },
        category: {
          type: 'string',
          description: 'Grant category, substring match, e.g. "Social Inclusion", "Academic Research", "Child Care".',
        },
        recipient_state: {
          type: 'string',
          description: 'Australian state/territory of the recipient: ACT, NSW, VIC, QLD, SA, WA, TAS, NT.',
        },
        selection_process: {
          type: 'string',
          description:
            'How the grant was selected, substring match: "Open Competitive", "Demand Driven", "Targeted or Restricted Competitive", "Open Non-competitive", "Closed Non-Competitive".',
        },
        min_value: { type: ['number', 'string'], description: 'Only awards worth at least this many AUD.' },
        max_value: { type: ['number', 'string'], description: 'Only awards worth at most this many AUD.' },
        awarded_from: { type: 'string', description: 'Earliest publish date, ISO YYYY-MM-DD.' },
        awarded_to: { type: 'string', description: 'Latest publish date, ISO YYYY-MM-DD.' },
        sort: { type: 'string', description: 'Sort key: "date" (default, publish date) or "value" (AUD).' },
        order: { type: 'string', description: 'Sort direction: "desc" (default) or "asc".' },
        limit: { type: ['number', 'string'], description: 'Max awards to return (1-100, default 25).' },
        offset: { type: ['number', 'string'], description: 'Rows to skip, for paging (default 0).' },
      },
      required: [],
    },
  },
  {
    name: 'au_grant_award',
    description:
      'Full record for one awarded Australian Commonwealth grant, looked up by its GrantConnect award id (ga_id, e.g. "GA572409"). Returns recipient organisation with ABN and address, funding agency, PBS program, grant program and activity, the stated purpose, value in AUD, approval/start/end dates, selection process, delivery location, aggregate-grant flags and confidentiality flags — and, when the award records a go_id, the linked grant opportunity is fetched and inlined (title, close date, selection process, category, agency) so the advertised call that produced the payment is visible in the same answer.',
    inputSchema: {
      type: 'object',
      properties: {
        ga_id: {
          type: 'string',
          description: 'GrantConnect award id, e.g. "GA572409". A bare number is accepted and prefixed with GA.',
        },
      },
      required: ['ga_id'],
    },
  },
  {
    name: 'au_grants_by_recipient',
    description:
      'Every Australian Commonwealth grant awarded to one organisation, matched by recipient name substring or by exact Australian Business Number (ABN, accepted spaced as "48 008 389 151" or unspaced as "48008389151"). Returns the individual awards plus a funding total: total AUD received, number of awards, first and last award dates, and a per-agency breakdown of which departments funded them. Answers "how much Commonwealth grant money has this charity, university, council or company received, and from whom".',
    inputSchema: {
      type: 'object',
      properties: {
        recipient_name: {
          type: 'string',
          description: 'Organisation name, case-insensitive substring, e.g. "YWCA Canberra", "Monash University".',
        },
        abn: {
          type: 'string',
          description: 'Australian Business Number, spaced or unspaced. Matched exactly and preferred over recipient_name.',
        },
        awarded_from: { type: 'string', description: 'Earliest publish date, ISO YYYY-MM-DD.' },
        awarded_to: { type: 'string', description: 'Latest publish date, ISO YYYY-MM-DD.' },
        limit: { type: ['number', 'string'], description: 'Max individual awards listed (1-100, default 25). The totals cover more rows than are listed.' },
        offset: { type: ['number', 'string'], description: 'Rows to skip in the listed awards (default 0).' },
      },
      required: [],
    },
  },
  {
    name: 'au_grant_opportunities_open',
    description:
      'Australian Commonwealth grant opportunities that are still open for application — GrantConnect opportunities whose close date is in the future, soonest-closing first, with days remaining computed at request time. Each row carries go_id, title, funding agency, selection process, publish and close dates, primary and secondary category, contact email, addenda count and co-sponsor. Filter by category (e.g. "Regional Development"), agency substring, or free-text title match. Answers "what Australian federal grants can I still apply for, and when do they close".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched case-insensitively against the opportunity title.' },
        agency: { type: 'string', description: 'Funding agency, substring match, e.g. "Infrastructure", "Department of Health".' },
        category: {
          type: 'string',
          description: 'Category title, substring match against the primary or secondary category, e.g. "Regional Development".',
        },
        closing_within_days: {
          type: ['number', 'string'],
          description: 'Only opportunities closing within this many days from now.',
        },
        limit: { type: ['number', 'string'], description: 'Max opportunities (1-100, default 25).' },
        offset: { type: ['number', 'string'], description: 'Rows to skip, for paging (default 0).' },
      },
      required: [],
    },
  },
  {
    name: 'au_grants_top_recipients',
    description:
      'Rank the organisations that received the most Australian Commonwealth grant money, by total AUD awarded, with award counts and the agencies that funded them. Filter by agency, category, recipient_state, and an awarded_from/awarded_to date range. The response states how many award rows were scanned and whether that covered every matching row, so a ranking drawn from the largest awards can be told apart from a ranking over the complete set. Answers "who are the biggest recipients of federal grant funding in this portfolio, state or year".',
    inputSchema: {
      type: 'object',
      properties: {
        agency: { type: 'string', description: 'Funding agency, substring match, e.g. "Department of Social Services".' },
        category: { type: 'string', description: 'Grant category, substring match, e.g. "Social Inclusion".' },
        recipient_state: { type: 'string', description: 'Recipient state/territory: ACT, NSW, VIC, QLD, SA, WA, TAS, NT.' },
        awarded_from: { type: 'string', description: 'Earliest publish date, ISO YYYY-MM-DD.' },
        awarded_to: { type: 'string', description: 'Latest publish date, ISO YYYY-MM-DD.' },
        limit: { type: ['number', 'string'], description: 'How many recipients to rank (1-100, default 20).' },
        scan_limit: {
          type: ['number', 'string'],
          description:
            'How many award rows to read before ranking, largest-value first (1000-20000, default 5000). Raise it for a ranking that covers more of the matching set.',
        },
        include_aggregate: {
          type: 'boolean',
          description:
            'Default false. GrantConnect files bundled disclosures under the literal recipient name "Aggregate" when the individual recipients are withheld; those rows are excluded from the ranking because they are a reporting artefact rather than an organisation. Set true to count them as one pseudo-recipient.',
        },
      },
      required: [],
    },
  },
  {
    name: 'grantconnect_coverage',
    description:
      'What GrantConnect data Pipeworx actually holds right now: per-report ingest windows with their status and row counts, the earliest and latest dates present in the awarded-grants and grant-opportunities tables, total row counts, and any ingest windows that ended in error. Use this before trusting a date-bounded answer about Australian grants — it shows which years are loaded and which are still backfilling.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

/* ------------------------------------------------------------------ */
/* PostgREST plumbing                                                  */
/* ------------------------------------------------------------------ */

interface SupabaseConfig {
  url: string;
  key: string;
}

async function pg<T>(cfg: SupabaseConfig, table: string, query: string): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// Same as pg(), but also returns the exact number of rows matching the filters
// (ignoring limit/offset) from PostgREST's Content-Range header. Aggregate
// functions are disabled on the project, so this header is how the pack reports
// "how many rows really matched" without a count() call.
async function pgWithCount<T>(
  cfg: SupabaseConfig,
  table: string,
  query: string,
): Promise<{ rows: T[]; total: number | null }> {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} ${text}`);
  }
  const rows = (await res.json()) as T[];
  const range = res.headers.get('content-range') ?? '';
  const n = Number(range.split('/')[1]);
  return { rows, total: Number.isFinite(n) ? n : null };
}

async function pgCount(
  cfg: SupabaseConfig,
  table: string,
  query: string,
  selectColumn: string,
): Promise<number | null> {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}&select=${selectColumn}&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return null;
  const range = res.headers.get('content-range') ?? '';
  const n = Number(range.split('/')[1]);
  return Number.isFinite(n) ? n : null;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

// Strip characters that carry meaning inside a PostgREST filter expression
// (comma, parens, quotes) or inside LIKE (%, _) so a user phrase can never
// change the shape of the query it lands in.
function ilikeValue(raw: string): string {
  return raw
    .replace(/[,()"'\\%_*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ilikeFilter(column: string, raw: string): string | null {
  const v = ilikeValue(raw);
  if (!v) return null;
  return `${column}=ilike.*${encodeURIComponent(v)}*`;
}

// Free text across several columns, as PostgREST logic groups — one `or(...)`
// group per word, so every word must appear somewhere in any order.
function freeTextGroups(raw: string, columns: string[]): string[] {
  const cleaned = ilikeValue(raw);
  if (!cleaned) return [];
  const tokens = cleaned
    .split(' ')
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  return tokens.map(
    (tok) => `or(${columns.map((c) => `${c}.ilike.*${encodeURIComponent(tok)}*`).join(',')})`,
  );
}

// Fold every logic group into ONE query parameter. PostgREST's handling of a
// repeated top-level `or=` differs between versions, so anything beyond a single
// group is emitted as one `and=(...)` rather than two `or=` params.
function logicParam(groups: string[]): string | null {
  if (groups.length === 0) return null;
  if (groups.length === 1) {
    const g = groups[0];
    const open = g.indexOf('(');
    return `${g.slice(0, open)}=(${g.slice(open + 1, -1)})`;
  }
  return `and=(${groups.join(',')})`;
}

function isoDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeId(raw: string, prefix: 'GA' | 'GO'): string {
  const v = raw.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!v) return '';
  if (/^\d+$/.test(v)) return `${prefix}${v}`;
  return v;
}

// GrantConnect publishes ABNs spaced 2-3-3-3 ("48 008 389 151"), but callers
// paste them either way. Return both forms so the filter can match whichever
// the ingest stored.
function abnForms(raw: string): string[] {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 11) return [];
  const spaced = `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 11)}`;
  return [spaced, digits];
}

const AU_STATES = ['ACT', 'NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT'];

function normalizeState(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (!v) return '';
  if (AU_STATES.includes(v)) return v;
  const long: Record<string, string> = {
    'AUSTRALIAN CAPITAL TERRITORY': 'ACT',
    'NEW SOUTH WALES': 'NSW',
    VICTORIA: 'VIC',
    QUEENSLAND: 'QLD',
    'SOUTH AUSTRALIA': 'SA',
    'WESTERN AUSTRALIA': 'WA',
    TASMANIA: 'TAS',
    'NORTHERN TERRITORY': 'NT',
  };
  return long[v] ?? '';
}

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface AwardRow {
  ga_id: string;
  go_id: string | null;
  agency: string | null;
  internal_reference_id?: string | null;
  recipient_name: string | null;
  recipient_abn: string | null;
  pbs_program_name?: string | null;
  grant_program: string | null;
  grant_activity: string | null;
  purpose?: string | null;
  one_off?: boolean | null;
  is_aggregate?: boolean | null;
  aggregate_reason?: string | null;
  aggregate_number?: number | null;
  selection_process: string | null;
  category: string | null;
  confidentiality_contract?: boolean | null;
  confidentiality_outputs?: boolean | null;
  publish_date: string | null;
  approval_date: string | null;
  start_date: string | null;
  end_date: string | null;
  value_aud: number | string | null;
  recipient_suburb?: string | null;
  recipient_city?: string | null;
  recipient_postcode?: string | null;
  recipient_state: string | null;
  recipient_country?: string | null;
  delivery_state?: string | null;
  delivery_postcode?: string | null;
  delivery_country?: string | null;
  contact_name?: string | null;
  first_seen_at?: string | null;
  updated_at?: string | null;
}

interface OpportunityRow {
  go_id: string;
  agency: string | null;
  internal_reference_id?: string | null;
  title: string | null;
  selection_process: string | null;
  publish_date: string | null;
  close_date: string | null;
  addenda_count: number | null;
  fo_reference?: string | null;
  primary_category_code?: string | null;
  primary_category_title: string | null;
  secondary_category_code?: string | null;
  secondary_category_title?: string | null;
  co_sponsored?: boolean | null;
  co_sponsored_with?: string | null;
  contact_email?: string | null;
  first_seen_at?: string | null;
  updated_at?: string | null;
}

const AWARD_LIST_SELECT =
  'select=ga_id,go_id,agency,recipient_name,recipient_abn,grant_program,grant_activity,category,selection_process,value_aud,publish_date,approval_date,start_date,end_date,recipient_city,recipient_state,delivery_state';

const OPP_LIST_SELECT =
  'select=go_id,agency,title,selection_process,publish_date,close_date,addenda_count,primary_category_title,secondary_category_title,co_sponsored,co_sponsored_with,contact_email';

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shapeAward(r: AwardRow) {
  return {
    ga_id: r.ga_id,
    go_id: r.go_id,
    recipient: r.recipient_name,
    recipient_abn: r.recipient_abn,
    agency: r.agency,
    grant_program: r.grant_program,
    grant_activity: r.grant_activity,
    category: r.category,
    selection_process: r.selection_process,
    value_aud: num(r.value_aud),
    publish_date: r.publish_date,
    approval_date: r.approval_date,
    start_date: r.start_date,
    end_date: r.end_date,
    recipient_location: [r.recipient_city, r.recipient_state].filter(Boolean).join(', ') || null,
    recipient_state: r.recipient_state,
    delivery_state: r.delivery_state ?? null,
  };
}

function shapeOpportunity(r: OpportunityRow) {
  return {
    go_id: r.go_id,
    title: r.title,
    agency: r.agency,
    selection_process: r.selection_process,
    publish_date: r.publish_date,
    close_date: r.close_date,
    primary_category: r.primary_category_title,
    secondary_category: r.secondary_category_title ?? null,
    addenda_count: r.addenda_count,
    co_sponsored: r.co_sponsored ?? null,
    co_sponsored_with: r.co_sponsored_with ?? null,
    contact_email: r.contact_email ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Shared award filters                                                */
/* ------------------------------------------------------------------ */

function awardFilters(args: Record<string, unknown>): { parts: string[]; applied: Record<string, string> } {
  const parts: string[] = [];
  const groups: string[] = [];
  const applied: Record<string, string> = {};

  const query = str(args.query ?? args.q ?? args.search ?? args.keyword ?? args.keywords);
  const textGroups = query ? freeTextGroups(query, AWARD_TEXT_COLUMNS) : [];
  if (textGroups.length > 0) {
    groups.push(...textGroups);
    applied.query = query;
  }

  const agency = str(args.agency ?? args.department);
  const agencyFilter = agency ? ilikeFilter('agency', agency) : null;
  if (agencyFilter) {
    parts.push(agencyFilter);
    applied.agency = agency;
  }

  const category = str(args.category);
  const categoryFilter = category ? ilikeFilter('category', category) : null;
  if (categoryFilter) {
    parts.push(categoryFilter);
    applied.category = category;
  }

  const state = normalizeState(str(args.recipient_state ?? args.state));
  if (state) {
    parts.push(`recipient_state=eq.${encodeURIComponent(state)}`);
    applied.recipient_state = state;
  }

  const selection = str(args.selection_process);
  const selectionFilter = selection ? ilikeFilter('selection_process', selection) : null;
  if (selectionFilter) {
    parts.push(selectionFilter);
    applied.selection_process = selection;
  }

  const minValue = num(str(args.min_value));
  if (minValue !== null) {
    parts.push(`value_aud=gte.${minValue}`);
    applied.min_value = String(minValue);
  }
  const maxValue = num(str(args.max_value));
  if (maxValue !== null) {
    parts.push(`value_aud=lte.${maxValue}`);
    applied.max_value = String(maxValue);
  }

  const from = isoDate(str(args.awarded_from ?? args.from_date ?? args.start));
  if (from) {
    parts.push(`publish_date=gte.${from}`);
    applied.awarded_from = from;
  }
  const to = isoDate(str(args.awarded_to ?? args.to_date ?? args.end));
  if (to) {
    parts.push(`publish_date=lte.${to}`);
    applied.awarded_to = to;
  }

  const logic = logicParam(groups);
  if (logic) parts.push(logic);

  return { parts, applied };
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

async function searchAwards(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const { parts, applied } = awardFilters(args);
  const limit = clampInt(args.limit, 1, 100, 25);
  const offset = clampInt(args.offset, 0, 100_000, 0);
  const sortKey = str(args.sort).toLowerCase() === 'value' ? 'value_aud' : 'publish_date';
  const dir = str(args.order).toLowerCase() === 'asc' ? 'asc' : 'desc';

  const query = [
    ...parts,
    AWARD_LIST_SELECT,
    `order=${sortKey}.${dir}.nullslast,ga_id.desc`,
    `limit=${limit}`,
    `offset=${offset}`,
  ].join('&');

  const { rows, total } = await pgWithCount<AwardRow>(cfg, AWARDS_TABLE, query);

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_matching_awards',
      hint:
        Object.keys(applied).length === 0
          ? 'No awarded grants are loaded for these filters. Call grantconnect_coverage to see which GrantConnect reports and date ranges Pipeworx currently holds.'
          : `No awarded grants match ${JSON.stringify(applied)}. Try a shorter query, drop the date range, or check the date coverage with grantconnect_coverage. Agency and category are substring matches, so "Social Services" is safer than a full department title.`,
      filters_applied: applied,
    };
  }

  return {
    found: true,
    count: rows.length,
    total_matching: total,
    offset,
    sorted_by: `${sortKey} ${dir}`,
    filters_applied: applied,
    awards: rows.map(shapeAward),
    note: 'value_aud is the published grant value in Australian dollars. go_id links to the grant opportunity the award came from — pass it to au_grant_opportunities_open or use au_grant_award for the inlined opportunity.',
  };
}

async function awardDetail(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const gaId = normalizeId(str(args.ga_id ?? args.id ?? args.award_id), 'GA');
  if (!gaId) {
    return {
      found: false,
      reason: 'missing_ga_id',
      hint: 'Provide ga_id, the GrantConnect award id, e.g. "GA572409". Find one with au_grants_search or au_grants_by_recipient.',
    };
  }

  const rows = await pg<AwardRow[]>(
    cfg,
    AWARDS_TABLE,
    `ga_id=eq.${encodeURIComponent(gaId)}&select=*&limit=1`,
  );
  if (rows.length === 0) {
    return {
      found: false,
      reason: 'award_not_found',
      ga_id: gaId,
      hint: `No award ${gaId} is loaded. Ids look like "GA572409". Check the coverage window with grantconnect_coverage, or search by recipient with au_grants_by_recipient.`,
    };
  }

  const r = rows[0];
  let opportunity: ReturnType<typeof shapeOpportunity> | null = null;
  let opportunityNote: string | null = null;

  if (r.go_id) {
    const goId = normalizeId(r.go_id, 'GO');
    const opps = await pg<OpportunityRow[]>(
      cfg,
      OPPS_TABLE,
      `go_id=eq.${encodeURIComponent(goId)}&${OPP_LIST_SELECT}&limit=1`,
    );
    if (opps.length > 0) {
      opportunity = shapeOpportunity(opps[0]);
    } else {
      opportunityNote = `The award records go_id ${goId}, but that grant opportunity is outside the opportunities data currently loaded. Call grantconnect_coverage for the loaded window.`;
    }
  } else {
    opportunityNote = 'This award records no go_id — GrantConnect leaves it blank for grants not awarded under a published opportunity (for example ad hoc or ministerial grants).';
  }

  return {
    found: true,
    award: {
      ...shapeAward(r),
      internal_reference_id: r.internal_reference_id ?? null,
      pbs_program_name: r.pbs_program_name ?? null,
      purpose: r.purpose ?? null,
      one_off: r.one_off ?? null,
      is_aggregate: r.is_aggregate ?? null,
      aggregate_reason: r.aggregate_reason ?? null,
      aggregate_number: r.aggregate_number ?? null,
      confidentiality_contract: r.confidentiality_contract ?? null,
      confidentiality_outputs: r.confidentiality_outputs ?? null,
      recipient_suburb: r.recipient_suburb ?? null,
      recipient_postcode: r.recipient_postcode ?? null,
      recipient_country: r.recipient_country ?? null,
      delivery_postcode: r.delivery_postcode ?? null,
      delivery_country: r.delivery_country ?? null,
      contact_name: r.contact_name ?? null,
      first_seen_at: r.first_seen_at ?? null,
      updated_at: r.updated_at ?? null,
    },
    opportunity,
    opportunity_note: opportunityNote,
  };
}

async function byRecipient(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const abnRaw = str(args.abn ?? args.recipient_abn);
  const nameRaw = str(args.recipient_name ?? args.recipient ?? args.name ?? args.organisation ?? args.organization ?? args.query);

  const parts: string[] = [];
  const groups: string[] = [];
  let matchedBy = '';
  let matchedValue = '';

  if (abnRaw) {
    const forms = abnForms(abnRaw);
    if (forms.length === 0) {
      return {
        found: false,
        reason: 'invalid_abn',
        hint: 'An ABN is 11 digits, spaced or unspaced, e.g. "48 008 389 151" or "48008389151". Or pass recipient_name instead.',
      };
    }
    // GrantConnect stores the spaced form; the unspaced form is matched too in
    // case the ingest normalised it.
    groups.push(`or(${forms.map((f) => `recipient_abn.eq.${encodeURIComponent(f)}`).join(',')})`);
    matchedBy = 'recipient_abn';
    matchedValue = forms[0];
  } else if (nameRaw) {
    const nameGroups = freeTextGroups(nameRaw, ['recipient_name']);
    if (nameGroups.length === 0) {
      return {
        found: false,
        reason: 'invalid_recipient_name',
        hint: 'Pass a recipient_name of at least two characters, e.g. "YWCA Canberra".',
      };
    }
    groups.push(...nameGroups);
    matchedBy = 'recipient_name';
    matchedValue = nameRaw;
  } else {
    return {
      found: false,
      reason: 'missing_recipient',
      hint: 'Provide recipient_name (substring, e.g. "YWCA Canberra") or abn (11 digits). Use au_grants_search to find the exact spelling of an organisation name.',
    };
  }

  const from = isoDate(str(args.awarded_from));
  if (from) parts.push(`publish_date=gte.${from}`);
  const to = isoDate(str(args.awarded_to));
  if (to) parts.push(`publish_date=lte.${to}`);

  const logic = logicParam(groups);
  if (logic) parts.push(logic);

  // Totals are computed over a bounded scan of the matching rows; the listed
  // awards are a separate, paged slice of the same filter.
  const SCAN_CAP = 5000;
  const { rows: scanRows, total } = await pgWithCount<AwardRow>(
    cfg,
    AWARDS_TABLE,
    [
      ...parts,
      'select=ga_id,recipient_name,recipient_abn,agency,value_aud,publish_date',
      'order=publish_date.desc.nullslast,ga_id.desc',
      `limit=${SCAN_CAP}`,
    ].join('&'),
  );

  if (scanRows.length === 0) {
    return {
      found: false,
      reason: 'no_awards_for_recipient',
      matched_by: matchedBy,
      searched_for: matchedValue,
      hint:
        matchedBy === 'recipient_abn'
          ? 'No awards are loaded against that ABN. GrantConnect publishes ABNs spaced (e.g. "48 008 389 151") and leaves them blank on some records — try recipient_name instead, or check grantconnect_coverage.'
          : 'No awards match that organisation name. Names are recorded as the recipient wrote them (legal entity, not trading name) — try a distinctive fragment such as "YWCA" alone, or check grantconnect_coverage for the loaded date range.',
    };
  }

  let totalAud = 0;
  let valuedRows = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  const byAgency = new Map<string, { agency: string; awards: number; total_aud: number }>();
  const names = new Set<string>();
  const abns = new Set<string>();

  for (const r of scanRows) {
    const v = num(r.value_aud);
    if (v !== null) {
      totalAud += v;
      valuedRows += 1;
    }
    if (r.publish_date) {
      if (!firstDate || r.publish_date < firstDate) firstDate = r.publish_date;
      if (!lastDate || r.publish_date > lastDate) lastDate = r.publish_date;
    }
    const agency = r.agency ?? 'Unknown';
    const entry = byAgency.get(agency) ?? { agency, awards: 0, total_aud: 0 };
    entry.awards += 1;
    entry.total_aud += v ?? 0;
    byAgency.set(agency, entry);
    if (r.recipient_name) names.add(r.recipient_name);
    if (r.recipient_abn) abns.add(r.recipient_abn);
  }

  const limit = clampInt(args.limit, 1, 100, 25);
  const offset = clampInt(args.offset, 0, 100_000, 0);
  const listed = await pg<AwardRow[]>(
    cfg,
    AWARDS_TABLE,
    [
      ...parts,
      AWARD_LIST_SELECT,
      'order=publish_date.desc.nullslast,ga_id.desc',
      `limit=${limit}`,
      `offset=${offset}`,
    ].join('&'),
  );

  const complete = total === null ? scanRows.length < SCAN_CAP : total <= scanRows.length;

  return {
    found: true,
    matched_by: matchedBy,
    searched_for: matchedValue,
    matched_recipient_names: [...names].slice(0, 20),
    matched_abns: [...abns].slice(0, 20),
    totals: {
      total_aud: Math.round(totalAud * 100) / 100,
      award_count: scanRows.length,
      awards_with_a_published_value: valuedRows,
      first_award_date: firstDate,
      last_award_date: lastDate,
      funding_agencies: [...byAgency.values()]
        .sort((a, b) => b.total_aud - a.total_aud)
        .map((a) => ({ ...a, total_aud: Math.round(a.total_aud * 100) / 100 })),
    },
    totals_cover_all_matching_awards: complete,
    total_matching_awards: total,
    rows_scanned_for_totals: scanRows.length,
    awards: listed.map(shapeAward),
    note: complete
      ? 'Totals cover every matching award currently loaded. A recipient may appear under several name spellings — matched_recipient_names shows what was aggregated.'
      : `Totals cover the ${scanRows.length} most recent matching awards out of ${total ?? 'more'}; narrow the date range for a total over the full set.`,
  };
}

async function openOpportunities(cfg: SupabaseConfig, args: Record<string, unknown>) {
  // Computed per request: a module-scope Date in a Worker freezes at 1970.
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const parts: string[] = [`close_date=gte.${nowIso}`];
  const groups: string[] = [];
  const applied: Record<string, string> = {};

  const query = str(args.query ?? args.q ?? args.title ?? args.search ?? args.keyword);
  const titleGroups = query ? freeTextGroups(query, ['title']) : [];
  if (titleGroups.length > 0) {
    groups.push(...titleGroups);
    applied.query = query;
  }

  const agency = str(args.agency ?? args.department);
  const agencyFilter = agency ? ilikeFilter('agency', agency) : null;
  if (agencyFilter) {
    parts.push(agencyFilter);
    applied.agency = agency;
  }

  const category = ilikeValue(str(args.category));
  if (category) {
    const enc = encodeURIComponent(category);
    groups.push(`or(primary_category_title.ilike.*${enc}*,secondary_category_title.ilike.*${enc}*)`);
    applied.category = category;
  }

  const withinDays = num(str(args.closing_within_days));
  if (withinDays !== null && withinDays > 0) {
    parts.push(`close_date=lte.${new Date(now + withinDays * 86_400_000).toISOString()}`);
    applied.closing_within_days = String(withinDays);
  }

  const logic = logicParam(groups);
  if (logic) parts.push(logic);

  const limit = clampInt(args.limit, 1, 100, 25);
  const offset = clampInt(args.offset, 0, 100_000, 0);

  const { rows, total } = await pgWithCount<OpportunityRow>(
    cfg,
    OPPS_TABLE,
    [...parts, OPP_LIST_SELECT, 'order=close_date.asc.nullslast,go_id.asc', `limit=${limit}`, `offset=${offset}`].join('&'),
  );

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_open_opportunities',
      as_of: nowIso,
      filters_applied: applied,
      hint:
        Object.keys(applied).length === 0
          ? 'No GrantConnect opportunities with a future close date are loaded. Call grantconnect_coverage to see whether the opportunities report has been ingested and how fresh it is.'
          : 'No open opportunities match these filters. Category is matched as a substring of the primary or secondary category title (e.g. "Regional Development"); try dropping the category or the free-text query, or widen closing_within_days.',
    };
  }

  return {
    found: true,
    as_of: nowIso,
    count: rows.length,
    total_open_matching: total,
    offset,
    filters_applied: applied,
    opportunities: rows.map((r) => {
      const shaped = shapeOpportunity(r);
      const days = r.close_date
        ? Math.round(((new Date(r.close_date).getTime() - now) / 86_400_000) * 10) / 10
        : null;
      return { ...shaped, days_until_close: days };
    }),
    note: 'Ordered soonest-closing first. close_date carries a real time of day in the agency\'s published timezone as recorded by GrantConnect. Addenda can move a close date — addenda_count above zero means the notice has been amended.',
  };
}

async function topRecipients(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const { parts, applied } = awardFilters(args);
  parts.push('value_aud=not.is.null');

  // GrantConnect publishes bundled disclosures under the literal recipient name
  // "Aggregate" (is_aggregate = true) when it withholds the individual
  // recipients — 161 such rows carry ~$853M between them. They are a reporting
  // artefact, not an organisation, and because the ranking is money-ordered
  // they otherwise land at rank 1 and name "Aggregate" as the country's largest
  // grant recipient. Excluded by default; opt back in with include_aggregate.
  const includeAggregate = args.include_aggregate === true || args.include_aggregate === 'true';
  if (!includeAggregate) parts.push('is_aggregate=not.is.true');

  const limit = clampInt(args.limit, 1, 100, 20);
  const scanLimit = clampInt(args.scan_limit, 1000, 20_000, 5000);
  const PAGE = 1000;

  // Aggregate functions are disabled on this PostgREST project, so the ranking
  // is built in the pack from a bounded scan taken largest-award-first. That
  // ordering makes the sample the one that matters for a money ranking, but it
  // is still a sample — rows_scanned / total_matching_awards say so explicitly.
  const scanned: AwardRow[] = [];
  let total: number | null = null;
  for (let offset = 0; offset < scanLimit; offset += PAGE) {
    const page = Math.min(PAGE, scanLimit - offset);
    const res = await pgWithCount<AwardRow>(
      cfg,
      AWARDS_TABLE,
      [
        ...parts,
        'select=ga_id,recipient_name,recipient_abn,agency,value_aud,publish_date,recipient_state',
        'order=value_aud.desc.nullslast,ga_id.desc',
        `limit=${page}`,
        `offset=${offset}`,
      ].join('&'),
    );
    if (offset === 0) total = res.total;
    scanned.push(...res.rows);
    if (res.rows.length < page) break;
  }

  if (scanned.length === 0) {
    return {
      found: false,
      reason: 'no_awards_to_rank',
      filters_applied: applied,
      hint: 'No awards with a published value match these filters, so there is nothing to rank. Widen the date range or drop the agency/category filter, and check grantconnect_coverage for the loaded years.',
    };
  }

  interface Agg {
    recipient: string;
    recipient_abn: string | null;
    total_aud: number;
    award_count: number;
    states: Set<string>;
    agencies: Map<string, number>;
    largest_award_aud: number;
    first_date: string | null;
    last_date: string | null;
  }
  const byRecipientKey = new Map<string, Agg>();
  for (const r of scanned) {
    const name = r.recipient_name ?? 'Unknown recipient';
    const key = (r.recipient_abn ?? name).toString().trim().toLowerCase();
    const v = num(r.value_aud) ?? 0;
    const agg =
      byRecipientKey.get(key) ??
      ({
        recipient: name,
        recipient_abn: r.recipient_abn ?? null,
        total_aud: 0,
        award_count: 0,
        states: new Set<string>(),
        agencies: new Map<string, number>(),
        largest_award_aud: 0,
        first_date: null,
        last_date: null,
      } as Agg);
    agg.total_aud += v;
    agg.award_count += 1;
    if (v > agg.largest_award_aud) agg.largest_award_aud = v;
    if (r.recipient_state) agg.states.add(r.recipient_state);
    if (r.agency) agg.agencies.set(r.agency, (agg.agencies.get(r.agency) ?? 0) + v);
    if (r.publish_date) {
      if (!agg.first_date || r.publish_date < agg.first_date) agg.first_date = r.publish_date;
      if (!agg.last_date || r.publish_date > agg.last_date) agg.last_date = r.publish_date;
    }
    byRecipientKey.set(key, agg);
  }

  const ranked = [...byRecipientKey.values()]
    .sort((a, b) => b.total_aud - a.total_aud)
    .slice(0, limit)
    .map((a, i) => ({
      rank: i + 1,
      recipient: a.recipient,
      recipient_abn: a.recipient_abn,
      total_aud: Math.round(a.total_aud * 100) / 100,
      award_count: a.award_count,
      largest_award_aud: Math.round(a.largest_award_aud * 100) / 100,
      states: [...a.states],
      first_award_date: a.first_date,
      last_award_date: a.last_date,
      top_agencies: [...a.agencies.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([agency, aud]) => ({ agency, total_aud: Math.round(aud * 100) / 100 })),
    }));

  const complete = total !== null && total <= scanned.length;

  return {
    found: true,
    filters_applied: applied,
    rows_scanned: scanned.length,
    total_matching_awards: total,
    ranking_covers_all_matching_awards: complete,
    scan_order: 'value_aud desc — the scan takes the largest awards first',
    aggregate_disclosures_excluded: !includeAggregate,
    aggregate_note: includeAggregate
      ? 'Bundled "Aggregate" disclosures are INCLUDED, so a row named "Aggregate" is a group of undisclosed recipients rather than one organisation.'
      : 'Bundled "Aggregate" disclosures are excluded — GrantConnect files those under the literal recipient name "Aggregate" when it withholds the individual recipients, so they are not an organisation. Pass include_aggregate: true to count them.',
    distinct_recipients_in_scan: byRecipientKey.size,
    total_aud_in_scan: Math.round(scanned.reduce((s, r) => s + (num(r.value_aud) ?? 0), 0) * 100) / 100,
    recipients: ranked,
    note: complete
      ? `Ranking covers all ${scanned.length} matching awards with a published value.`
      : `Ranking is built from the ${scanned.length} largest matching awards out of ${total ?? 'an unknown number of'} total — recipients with many small grants may be under-counted. Raise scan_limit (max 20000) or narrow the filters for a complete ranking.`,
  };
}

interface IngestStateRow {
  report?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  status?: string | null;
  rows_written?: number | null;
  error?: string | null;
  message?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

async function coverage(cfg: SupabaseConfig) {
  const [states, awardCount, oppCount] = await Promise.all([
    pg<IngestStateRow[]>(cfg, INGEST_TABLE, 'select=*&order=window_start.asc&limit=2000').catch(() => null),
    pgCount(cfg, AWARDS_TABLE, 'ga_id=not.is.null', 'ga_id'),
    pgCount(cfg, OPPS_TABLE, 'go_id=not.is.null', 'go_id'),
  ]);

  const dateBound = async (table: string, column: string, dir: 'asc' | 'desc') => {
    const rows = await pg<Array<Record<string, string | null>>>(
      cfg,
      table,
      `select=${column}&${column}=not.is.null&order=${column}.${dir}&limit=1`,
    ).catch(() => [] as Array<Record<string, string | null>>);
    return rows.length > 0 ? rows[0][column] ?? null : null;
  };

  const [awardMin, awardMax, oppMin, oppMax, oppCloseMax] = await Promise.all([
    dateBound(AWARDS_TABLE, 'publish_date', 'asc'),
    dateBound(AWARDS_TABLE, 'publish_date', 'desc'),
    dateBound(OPPS_TABLE, 'publish_date', 'asc'),
    dateBound(OPPS_TABLE, 'publish_date', 'desc'),
    dateBound(OPPS_TABLE, 'close_date', 'desc'),
  ]);

  const reports: Array<{
    report: string;
    windows: number;
    earliest_window_start: string | null;
    latest_window_end: string | null;
    rows_written: number;
    status_counts: Record<string, number>;
    error_windows: Array<{ window_start: string | null; window_end: string | null; detail: string | null }>;
  }> = [];

  if (states) {
    const grouped = new Map<string, IngestStateRow[]>();
    for (const s of states) {
      const key = String(s.report ?? 'unknown');
      const list = grouped.get(key) ?? [];
      list.push(s);
      grouped.set(key, list);
    }
    for (const [report, rows] of grouped) {
      const statusCounts: Record<string, number> = {};
      let rowsWritten = 0;
      let earliest: string | null = null;
      let latest: string | null = null;
      const errorWindows: Array<{
        window_start: string | null;
        window_end: string | null;
        detail: string | null;
        attempts: number | null;
        last_run_at: string | null;
      }> = [];
      for (const r of rows) {
        const st = String(r.status ?? 'unknown');
        statusCounts[st] = (statusCounts[st] ?? 0) + 1;
        rowsWritten += Number(r.rows_written ?? 0) || 0;
        const ws = r.window_start ?? null;
        const we = r.window_end ?? null;
        if (ws && (!earliest || ws < earliest)) earliest = ws;
        if (we && (!latest || we > latest)) latest = we;
        if (st.toLowerCase() === 'error' || st.toLowerCase() === 'failed') {
          errorWindows.push({
            window_start: ws,
            window_end: we,
            // Column is `last_error` (migration 057). The older `error`/`message`
            // fallbacks are kept only so a schema rename can't blank this out.
            detail:
              (r.last_error as string | null) ??
              (r.error as string | null) ??
              (r.message as string | null) ??
              null,
            attempts: r.attempts != null ? Number(r.attempts) : null,
            last_run_at: (r.last_run_at as string | null) ?? null,
          });
        }
      }
      reports.push({
        report,
        windows: rows.length,
        earliest_window_start: earliest,
        latest_window_end: latest,
        rows_written: rowsWritten,
        status_counts: statusCounts,
        error_windows: errorWindows.slice(0, 25),
      });
    }
    reports.sort((a, b) => a.report.localeCompare(b.report));
  }

  const backfilling =
    (awardCount ?? 0) === 0 && (oppCount ?? 0) === 0
      ? 'No GrantConnect rows are loaded yet — the ingest worker is still backfilling. Every query tool will return found:false until the first windows complete.'
      : null;

  return {
    source: 'GrantConnect (grants.gov.au) — Australian Commonwealth grant opportunities and grants awarded, mirrored by Pipeworx because GrantConnect publishes no JSON API.',
    awarded_grants: {
      table: AWARDS_TABLE,
      row_count: awardCount,
      earliest_publish_date: awardMin,
      latest_publish_date: awardMax,
    },
    grant_opportunities: {
      table: OPPS_TABLE,
      row_count: oppCount,
      earliest_publish_date: oppMin,
      latest_publish_date: oppMax,
      latest_close_date: oppCloseMax,
    },
    ingest_reports: reports,
    ingest_state_readable: states !== null,
    backfill_note: backfilling,
    note: 'earliest/latest publish dates are the real bounds of the loaded data. A window listed under status "error" was attempted and did not land, so dates inside it are missing even though the surrounding range looks continuous.',
  };
}

/* ------------------------------------------------------------------ */

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = (args._supabaseUrl as string | undefined)?.trim();
  const supabaseKey = (args._supabaseKey as string | undefined)?.trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('grantconnect-au pack requires platform Supabase credentials (operator-configured).');
  }
  const cfg: SupabaseConfig = { url: supabaseUrl, key: supabaseKey };

  switch (name) {
    case 'au_grants_search':
      return searchAwards(cfg, args);
    case 'au_grant_award':
      return awardDetail(cfg, args);
    case 'au_grants_by_recipient':
      return byRecipient(cfg, args);
    case 'au_grant_opportunities_open':
      return openOpportunities(cfg, args);
    case 'au_grants_top_recipients':
      return topRecipients(cfg, args);
    case 'grantconnect_coverage':
      return coverage(cfg);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
