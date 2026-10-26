# Copilot instructions

Read [AGENTS.md](../AGENTS.md) first: it has the architecture, the commands and the config layout. The rules below are the ones to keep in mind on every suggestion.

- **Never edit core in a company fork.** A fork adds only `config/<company>/` and `extensions/`. Generic fixes go upstream as a pull request ([runbook](../docs/connect-your-company.md#send-a-generic-fix-upstream)).
- **Tests on both sides.** Backend behaviour gets an xUnit test (`dotnet test --solution backend/ObservabilityCity.slnx -c Release`). Browser behaviour gets a Vitest unit test (`cd frontend && npm test`) and, when it shows in the town, a Playwright test (`npm run e2e`). If a change touches one side only, say so in the pull request.
- **Branches and pull requests.** Never push to `main`; never force-push `main`.
- **No secrets or company identifiers in the repo.** Use `az login`, user secrets or Key Vault. Docs and tests use generic example names.
- **Tests use fakes and recorded fixtures, never live Azure, Grafana or Prometheus.** Probes and adapters sit behind interfaces (`ISourceProbe`, `ITokenProvider`, `IMetricSource`).
- **A signal that is not configured is absent, not grey.** Missing or stale data is never shown as healthy.
- **Config:** one YAML per pillar, ids are `pillar.system`, defaults cascade `defaults.yaml` -> pillar -> system, environments only say what differs. Check with `dotnet run --project backend/tools/ObservabilityCity.Validate -- --all` and, for connectivity, `-- --sources config/<company>`.
- **Style:** match the surrounding code; comments explain why; small pure functions that tests can call.
- After changing a C# snapshot record, run `cd frontend && npm run gen:contracts`.
