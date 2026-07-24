# .devops

Automation for the **free-api-news** pipeline: collecting free/discounted LLM API information, building a single HTML page, and deploying to GitHub Pages.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  .devops/                                        │
│  ├── config/env.sh          ← Environment vars   │
│  ├── batch/                 ← Collection         │
│  │   ├── run-skill.sh       ← Runs LLM Deals Skill│
│  │   ├── collect-fallback.js ← Fallback collector │
│  │   └── install-cron.sh    ← Local scheduler     │
│  ├── deploy/                ← Deployment          │
│  │   ├── build-html.sh      ← JSON → HTML        │
│  │   └── git-push.sh        ← Commit & push       │
│  └── README.md              ← This file           │
│                                                    │
│  build/                                        │
│  ├── build-html.js          ← HTML generator     │
│  └── validate-report.js     ← Schema validator   │
│                                                    │
│  ├── .agents/skills/llm-deals-intelligence-skill/   │
│  ├── SKILL.md              ← Skill instructions   │
│  ├── config/               ← Sources & queries    │
│  ├── prompts/              ← Subagent prompts     │
│  ├── schemas/              ← JSON schema          │
│  └── state/                ← Previous state       │
│                                                    │
│  index.html                ← Generated page       │
│  report.json               ← Generated report     │
└─────────────────────────────────────────────────┘
```

## Data Flow

1. **Batch** (`run-skill.sh`) runs the LLM Deals Intelligence Skill via pi
   - pi uses `web_search` and `browser` tools
   - Follows the 10-phase workflow (discovery → editor)
   - Produces `report.json` (validated against JSON schema)

2. **Build** (`build-html.sh`) converts `report.json` → `index.html`
   - Single self-contained HTML file
   - Uses Tailwind CSS CDN with shadcn/ui styling
   - Includes dark mode toggle

3. **Deploy** (`git-push.sh`) commits the artifacts and pushes the current branch
   - Runs locally as the last step of `npm run full`
   - GitHub Pages serves directly from that branch (no CI)

## Quick Start

### Local Development

```bash
# 1. Run the skill (requires pi CLI)
.devops/batch/run-skill.sh

# 2. Build the HTML page
.devops/deploy/build-html.sh

# 3. Preview
python3 -m http.server 8000
# Open http://localhost:8000
```

### GitHub Pages Setup

1. Push to GitHub
2. Go to Settings → Pages
3. Source: **Deploy from a branch** → `master` / root
4. The local cron runs `npm run full` daily at 11:00 JST and pushes here

### Local scheduling

The batch runs on this machine (pi + camofox browser + web_search), not in CI.

```bash
.devops/batch/install-cron.sh            # print the cron line
.devops/batch/install-cron.sh --install  # add it to crontab (idempotent)
```

## Scripts

### `.devops/batch/run-skill.sh`

Runs the LLM Deals Intelligence Skill.

```bash
.devops/batch/run-skill.sh           # Full run
.devops/batch/run-skill.sh --dry-run # Validate existing report only
```

**Requires:** pi CLI with `web_search` and `browser` tools.

If pi is not available, falls back to `collect-fallback.js` (manual collection).

### `.devops/deploy/build-html.sh`

Converts `report.json` to `index.html`.

```bash
.devops/deploy/build-html.sh [input.json] [output.html]
```

### `.devops/deploy/git-push.sh`

Commits and pushes the HTML page.

```bash
.devops/deploy/git-push.sh "Custom commit message"
```

### `.devops/batch/install-cron.sh`

Registers the daily local batch with cron.

```bash
.devops/batch/install-cron.sh            # print the cron line
.devops/batch/install-cron.sh --install  # add to crontab (idempotent)
```

The schedule (`SCHEDULE_CRON`) is in the machine's local time; keep the machine
in `Asia/Tokyo` for 11:00 JST. Runs through a login shell so nodenv/nvm PATH is loaded.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROJECT_ROOT` | Auto-detected | Project root directory |
| `SKILL_DIR` | `$PROJECT_ROOT/.agents/skills/llm-deals-intelligence-skill` | Skill directory |
| `REPORT_FILE` | `$PROJECT_ROOT/report.json` | Output report path |
| `HTML_FILE` | `$PROJECT_ROOT/index.html` | Output HTML path |
| `SCHEDULE_CRON` | `0 11 * * *` | Local cron schedule (machine local time) |
| `TIMEZONE` | `Asia/Tokyo` | Intended machine timezone |
| `GIT_COMMIT_USER` | unset | Optional commit author override |
| `PI_MODEL` | `litellm/qwen3.8-max-preview` | pi model for the local batch |
| `PI_TIMEOUT` | `1800` | pi timeout in seconds |

## Secrets

None. The batch runs locally and pushes with your own git credentials, so there
are no CI secrets to configure (`PI_API_KEY` / `GITHUB_TOKEN` are not used).

## Skill Workflow

The LLM Deals Intelligence Skill follows a 10-phase workflow:

| Phase | Description | Tools |
|---|---|---|
| 0 | Discover new models | web_search (24h/72h/30d) |
| 1 | Search for offers | web_search (EN/JA/ZH) |
| 2 | Check providers | browser |
| 3 | Community scan | web_search (Reddit/GitHub/HN) |
| 4 | Verify offers | browser |
| 5 | Normalize pricing | — |
| 6 | Classify offers | — |
| 7 | Score risk | — |
| 8 | Compare state | file I/O |
| 9 | Write report | file I/O |

## Output

The generated `index.html` includes:

1. **Ranked offers** — Verified free/discounted APIs with links
2. **Conditional credits** — Student/startup/research credits
3. **Setup instructions** — pi, Claude Code, OpenCode, Codex config
4. **Registration steps** — 4-step signup guide
5. **Usage examples** — Copy-paste curl commands
