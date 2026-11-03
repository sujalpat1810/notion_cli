# notion_cli

Build Notion templates (expense tracker, clients/CRM, projects, finance, content calendar, …) and
dashboards in your own Notion workspace from YAML specs, from the command line.

> Status: **M1, foundation**. Auth, `doctor` and the rate-limited Notion client are in place.
> The template engine (M2+) is next. See the roadmap below.

## Setup

Requires Node 22.12+ and pnpm.

```powershell
pnpm install
pnpm dev --help              # run from source
pnpm build; pnpm link --global   # optional: install `notion-cli` / `ncli` globally
```

## Connect to Notion

1. Create a token at <https://app.notion.com/developers/connections>.
   A **personal access token** acts as you, so you don't need to share pages with it. An internal connection token
   only sees pages shared with it (••• → Connections).
2. Create an empty page in Notion (e.g. "notion-cli sandbox") and copy its URL.
3. Log in. The token is stored in the Windows Credential Manager, never in a plain file:

```powershell
pnpm dev auth login --parent "<sandbox page URL>"
pnpm dev auth status
pnpm dev doctor --probe      # tests what your plan allows: databases, views, dashboards, uploads
```

`NOTION_TOKEN` overrides the stored token (useful for CI). `--profile <name>` keeps several workspaces apart.

## Commands

| Command | What it does |
|---|---|
| `auth login [--parent <url>]` · `auth status` · `auth logout` | store, inspect and remove the token |
| `doctor [--parent <url>] [--probe] [--probe-charts]` | check token, parent page and plan capabilities |

Global flags: `--json`, `--profile <name>`, `--debug` (logs every HTTP call, without headers, to the log dir), `--no-color`.

## Roadmap

- **M1 (now):** auth, doctor, throttled client with safe retries (creates are never blindly replayed)
- **M2:** spec format + engine: databases, relations, rollups, formulas, sample rows; `plan` / `apply` / `destroy`
- **M3:** page bodies (Notion-flavoured markdown) and linked views
- **M4:** database views and dashboards (native dashboard → linked charts → static KPI/PNG fallback)
- **M5:** starter templates: expense tracker, CRM, projects, finance (GST), content calendar
- **M6:** `generate "<description>"`: Claude writes a template spec for you

## Development

```powershell
pnpm test        # unit tests
pnpm typecheck
pnpm build
```
