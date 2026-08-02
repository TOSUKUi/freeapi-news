# .devops

Automation for the **free-api-news** pipeline: collecting free/discounted LLM
API information into a fail safe SQLite backed collector, building a single
HTML page, and deploying to GitHub Pages.

## Architecture

```
.devops/
├── config/env.sh            ← Environment vars (PI_MODEL, concurrency, cron)
├── db/                      ← Fail safe collector (spec 0003)
│   ├── cli.js               ← Command entry point (npm scripts call this)
│   ├── collect.js           ← End to end orchestrator (collect / dry-run / full)
│   ├── collector-db.js      ← node:sqlite state store, migrations, finalize
│   ├── lanes.js             ← known / discovery / catalog lanes, reduction gate
│   ├── catalog.js           ← deterministic provider catalog fetch (no LLM)
│   ├── benchmarks.js        ← benchmark queue, proposal validation, tier gate
│   ├── assemble.js          ← deterministic report assembly from SQLite + prose
│   ├── publication.js       ← candidate validation, promotion, deploy, recovery
│   ├── import-legacy.js     ← one time cutover import of the old JSON state
│   ├── migrations/          ← numbered SQL migrations
│   └── *.test.js            ← fixture tests (npm test)
├── batch/install-cron.sh    ← Local scheduler registration
└── README.md                ← This file

build/
├── build-html.js            ← report.json → index.html
├── build-og-image.js        ← report.json → og-image.png
├── validate-report.js       ← schema validator + live citation re-fetch
└── provider-registry.json   ← human managed endpoint registry (tracked)

.agents/skills/llm-deals-intelligence-skill/
├── prompts/                 ← worker role contracts (facts, scout, classifier, editor)
├── schemas/                 ← JSON schemas enforced on every LLM call
└── state/                   ← SQLite operational state (local only, git ignored)
```

## Data flow

`npm run collect` drives the whole pipeline through `.devops/db/cli.js`:

1. **Migrate + recover** — apply migrations; restore or flag any promotion
   interrupted mid phase on a previous run.
2. **Pre run DB copy** — copy the closed SQLite file into the ignored run
   directory before any mutation (normal recovery input).
3. **Manifest + start run** — build the lane manifest from current state and
   the registry; create the run and task rows.
4. **Catalog** — deterministic `GET /api/v1/models` style fetch for providers
   with an `api_catalog_url`. No LLM. Failure preserves prior offers.
5. **Lane workers** (LLM, parallel) — `known_refresh` re-verifies known offers;
   `discovery` searches for new models and never mutates known offers.
6. **Lane reduction** (deterministic) — liveness (`verified` / `stale` /
   `confirmed_removed`), enums, and the promotion gate. Zero verified known
   offers blocks promotion; the previous report stays live.
7. **Benchmark scout** (LLM) + reduction (deterministic) — only models missing
   the gate score are searched; proposals become immutable facts only after
   evidence validation.
8. **Classifier + editor** (LLM) — final classification and Japanese prose only.
9. **Assembly + validation + promotion** (deterministic) — build the candidate
   under the run directory, validate and build HTML/OG there, then promote the
   canonical files only after every check passes. `--push` also commits and
   pushes; a push failure keeps the run `validated_not_deployed` for retry.

## Commands

```bash
npm run collect          # collect → validate candidate → promote locally (no push)
npm run collect:dry-run  # collect → validate candidate (no promote, no deploy)
npm run deploy           # commit and push the newest promoted generation
npm run full             # collect → promote → deploy
npm run validate-candidate # validate a candidate report / HTML / OGP
npm run promote          # promote a validated candidate (atomic canonical files)
npm run recover          # recover an interrupted promotion/deploy state
npm run cleanup          # remove run directories older than seven days
npm test                 # fixture tests for the collector

DB administration (SQLite state only, never deployed):

npm run db:status        # schema version, active run, last promoted run, DB copies
npm run db:migrate       # apply numbered migrations
npm run db:bootstrap     # emergency one time import from report.json
npm run db:import-legacy # one time cutover import of known_offers/benchmarks JSON
npm run db:restore       # restore the newest validated DB copy
```

The lower level steps are also callable directly:

```bash
node .devops/db/cli.js manifest <run_dir>
node .devops/db/cli.js ingest <run_id> <run_dir>
node .devops/db/cli.js reduce <run_id> <run_dir>
node .devops/db/cli.js bench-queue <run_dir>
node .devops/db/cli.js bench-reduce <run_id> <run_dir>
node .devops/db/cli.js candidate-view <run_dir>
node .devops/db/cli.js assemble <run_id> <run_dir>
node .devops/db/cli.js validate-candidate <run_id> <run_dir>
node .devops/db/cli.js promote <run_id> <run_dir>
node .devops/db/cli.js recover
```

## Fail safe guarantees

- Current tracked files (`report.json`, `index.html`, `og-image.png`,
  `build/provider-registry.json`) change only after a candidate passes every
  check, via a phased promotion manifest with backups and hash verification.
- A failed run leaves the previous published generation and durable state
  intact. A failed provider makes an offer `stale`, never `confirmed_removed`.
- A git push failure records `validated_not_deployed` and preserves the
  generation for `npm run deploy` retry; the remote Pages revision is unchanged.
- An interrupted promotion is recovered on the next mutating command.

## Local scheduling

The batch runs on this machine (pi + camofox browser + web_search), not in CI.

```bash
.devops/batch/install-cron.sh            # print the cron line
.devops/batch/install-cron.sh --install  # add it to crontab (idempotent)
```

The schedule (`SCHEDULE_CRON`) is in the machine's local time; keep the machine
in `Asia/Tokyo` for 11:00 JST. It runs `npm run full` through a login shell so
nodenv/nvm PATH is loaded.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PI_MODEL` | `litellm/free` | pi model for the LLM workers |
| `PI_TIMEOUT` | `1800` | pi worker timeout in seconds |
| `GLOBAL_CONCURRENCY` | `2` | parallel LLM worker count |
| `SKIP_CITATION_CHECK` | unset | set to `1` to skip live citation re-fetch |
| `SCHEDULE_CRON` | `0 11 * * *` | local cron schedule (machine local time) |
| `TIMEZONE` | `Asia/Tokyo` | intended machine timezone |

## Secrets

None. API keys stay in the environment and are never written to SQLite, task
JSON, logs, reports, or the source cache. The batch pushes with your own git
credentials.
