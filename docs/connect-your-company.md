# Connect your company

How to take a fork of Observability City from the fake town to your own Azure and Grafana, one source at a time. Nothing in this runbook needs a secret in the repository.

What works today: the town runs on fake data, and `validate --sources` tells you whether your Azure login can reach each source you configure. The adapters that turn real data into the town arrive phase by phase (real metrics, then messaging, then incidents); each one is added by the same steps, and a source you have not enabled yet stays out of the town.

## The shape of a fork

A fork adds only two things and never edits core:

- `config/<company>/`: your town (pillars, systems, environments).
- `extensions/`: your own code, when something is specific to your company.

Anything generic goes back upstream ([below](#send-a-generic-fix-upstream)). This keeps pulling upstream updates conflict-free.

## 1. Fork and clone

```
gh repo fork dcarles/ObservabilityCity --clone
cd ObservabilityCity
git remote add upstream https://github.com/dcarles/ObservabilityCity.git   # if the fork command did not
dotnet run --project backend/src/ObservabilityCity.AppHost
```

Check that the sample town opens on http://localhost:5173 before you change anything. You need .NET SDK 10 and Node 24 (see the README).

## 2. Sign in to Azure

```
az login
az account set --subscription "<subscription name or id>"
```

The tool and the backend use `DefaultAzureCredential`: it finds your `az login` on a laptop and a managed identity when hosted. There is no password or key in the repo or in `config/`.

Where a value must be kept (for example a Grafana service account token):

- **On your machine:** an environment variable, or `dotnet user-secrets` for the host project.
- **When hosted:** Azure Key Vault, read through the managed identity.

`.gitignore` already excludes `.env` and `secrets.json`. Never commit a connection string with a key in it; use the namespace or workspace *name* or *id* and let the login do the rest.

Your login needs read access only: Monitoring Reader on the Prometheus / Log Analytics workspace, and a role that can list topics on the Service Bus namespace.

## 3. Create your town

```
mkdir config/<company>
```

Start from the sample (`config/galactic-credit`) and keep the same layout:

```
config/<company>/
  town.yaml
  defaults.yaml
  hub.yaml                  shared resources (gateway, message broker, egress, shared databases)
  layout.yaml
  third-parties.yaml
  pillars/<pillar>.yaml     one island per pillar
  environments/<env>.yaml   dev, staging, prod...
```

Ids are `pillar.system`. Defaults cascade `defaults.yaml` -> pillar -> system. Pillar and system files are shared by every environment, so an environment file only says what differs: its sources, its tenants and the systems that are not deployed there (`exclude`). Ownership comes from your Azure `pillar` tag; a resource with no pillar lands on the Lost & found island.

Check the files as you go:

```
dotnet run --project backend/tools/ObservabilityCity.Validate -- config/<company>
```

Errors name the file and line. Every folder with a `town.yaml` under `config/` shows up in the town switcher with no setting.

## 4. Add one source at a time

Start with one environment (dev) and one signal (metrics). In `environments/dev.yaml`:

```yaml
name: Development
order: 1
sources:
  metrics: { kind: prometheus, connection: "https://<your-prometheus-query-endpoint>" }
```

| Signal | Kinds | `connection` is |
| --- | --- | --- |
| `metrics` | `prometheus`, `loganalytics` | The Prometheus query endpoint URL, or the Log Analytics workspace id |
| `messaging` | `servicebus` | The namespace host name, for example `sb-example.servicebus.windows.net` |
| `incidents` | `grafana-irm` | The Grafana URL (token in the `GRAFANA_TOKEN` environment variable) |
| any | `fake` | Nothing; keeps fake data for that signal |

A signal you leave out is absent from the town, not grey. Add the next one only when the last one reports `connected`.

### Name your sources, then point each signal at one

`metrics`, `messaging` and `incidents` are the names a signal uses unless you say otherwise, but a source can have any lowercase kebab-case name, and each signal can be pointed at a different one. A company that reads request rate from one place and instance counts from another writes:

```yaml
name: Production
sources:
  telemetry: { kind: loganalytics, connection: "<workspace id>", pollSeconds: 60, timeoutSeconds: 20 }
  inventory: { kind: resourcegraph, connection: "<scope>" }
signals:                      # signal: source name, or none
  requests: telemetry
  errors: telemetry
  latency: telemetry
  instances: inventory
```

The signals are `requests`, `errors`, `latency`, `instances`, `cpu`, `memory`, `utilisation`, `throttled`, `backlog` and `deadLetters`. A signal comes from, in order: the system's own `signals:`, its pillar's `signals:`, the environment's `signals:`, then the environment's source called `metrics` (`messaging` for `backlog` and `deadLetters`). `none` switches a signal off for that system or pillar. A signal that ends up with no source is absent, and the town shows nothing for it: no lamp, no row in the inspector, no total in the top bar. That is different from grey, which is a source that is configured but has nothing fresh to say.

```yaml
# pillars/<pillar>.yaml or a system in it
signals: { cpu: platform }    # every system of the pillar takes cpu from the source called platform
```

Every source takes `pollSeconds` (default 30) and `timeoutSeconds` (default 10). Which kinds the build can already read is in the table of the phase you are on; a kind the registry accepts before its adapter exists shows no data (grey) and the server says so when it starts.

### Logins

Azure sources (`resourcegraph`, `loganalytics`, `azuremonitor`, `servicebus`) sign in with whoever ran `az login`, unless you say otherwise. Define logins in the environment file and name one on a source:

```yaml
credentials:
  reader: { kind: service-principal, tenantId: "<tenant>", clientId: "<app id>", clientSecretEnv: REPORTER_SECRET }
sources:
  platform: { kind: azuremonitor, credential: reader }
```

| Kind | Signs in as |
| --- | --- |
| `azure-cli` (the default) | The account `az login` signed in |
| `default` | The Azure SDK's usual chain: environment variables, managed identity, developer tools |
| `managed-identity` | The identity of the machine it runs on (`clientId` picks a user-assigned one) |
| `service-principal` | An app registration. `clientSecretEnv` is the *name* of the environment variable that holds its secret; the secret never goes in a file |

A login defined with the name `default` replaces the Azure CLI one for every source that names none. Nobody is signed in when the server starts: a token is asked for when a source first needs it, so a town starts before `az login` and a missing login costs only the signals that need it. A service principal whose variable is not set is reported at start-up and its sources are left out.

### What each adapter's runbook section contains

Each real adapter lands with its own section here, with the same four parts: the permission the login needs, the `connection` value, the `pollSeconds` and `timeoutSeconds` that suit it, and what `--sources` reports for it. Until an adapter has its section, its kind is only accepted by the registry.

## 5. Run the check

```
dotnet run --project backend/tools/ObservabilityCity.Validate -- --sources config/<company>
```

For each environment and signal it makes one cheap read with your Azure login and says one of:

| Result | Means | What to do |
| --- | --- | --- |
| connected | It answered with data | Nothing |
| no permission | Refused (401/403), or no login or token | `az login`, check the role, set `GRAFANA_TOKEN` |
| query returned nothing | It answered but had no data | Wrong workspace or endpoint, or nothing is reporting yet. Not a failure unless you pass `--strict` |
| unreachable | No answer, an error, or a timeout | Check the address, VPN, firewall |
| not configured | The environment has no source for this signal | Fine; the town leaves the signal out |
| unknown kind | The kind is spelt wrong or has no probe | The message lists the kinds it knows |
| no probe yet | The registry accepts the kind but its probe arrives with its adapter | Nothing; not a failure |

The exit code is 1 when anything is *no permission*, *unreachable* or *unknown kind* (and, with `--strict`, *empty*), so you can run it in a pipeline.

The normal registry check (`-- config/<company>`) validates the files, including source names, kinds, logins and signal choices, and warns about a signal pointed at a source the environment does not define. `--sources` reads the environment files directly and reports every source you defined, so you can verify connectivity before the adapter lands.

## 6. Watch the town

```
dotnet run --project backend/src/ObservabilityCity.AppHost
```

Open http://localhost:5173, pick your town in the top bar, then the environment. Check a few buildings against the tool you trust today. Use **Break things** on the fake sample town to learn what each light, floor and beacon means before you read your own.

## 7. Then the next environment, the next signal

Repeat steps 4 to 6 for the next signal, then copy the environment file for staging and prod. Commit `config/<company>/` on a branch and open a pull request in your fork; the registry check runs in CI and comments on the pull request.

## Send a generic fix upstream

If you found a bug or a missing capability that is not specific to your company:

```
git fetch upstream
git checkout -b fix/short-description upstream/main
# make the change in core, with tests on both sides (backend xUnit, frontend Vitest / Playwright)
git push -u origin fix/short-description
gh pr create --repo dcarles/ObservabilityCity --base main
```

Rules for the upstream pull request: no company names, tenant ids, hostnames or screenshots of your town; examples use generic names; tests use fakes and recorded fixtures, never live services. Once it is merged, `git fetch upstream && git merge upstream/main` brings it into your fork. A fix that only makes sense at your company stays in `config/<company>/` or `extensions/`.

## When something goes wrong

- **No Azure login** (`no permission` with "run az login"): `az login`, then `az account show` to confirm the subscription.
- **Everything unreachable:** try the address in a browser or with `curl`; a corporate proxy or VPN is the usual cause.
- **The town is empty or grey:** grey means configured but no fresh data; run `--sources` and fix whatever is not *connected*.
- **Registry errors:** the message names the file, line and rule. The README lists every rule.
