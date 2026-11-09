using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>Turning a system of a pillar file into a registry node: its settings, signals and kind. Part of <see cref="RegistryLoader"/>.</summary>
public static partial class RegistryLoader
{
    private static IEnumerable<RegistryNode> final0(List<RegistryGroup> groups) => groups.SelectMany(g => g.Nodes);

    private static string RoleList => "api, worker, db, cache, function (or cron), gateway, broker or egress";

    private static RegistryNode? ToNode(
        SystemFile s, string groupId, string fileName, string prefix,
        DefaultsFile appDefaults, DefaultsFile pillarDefaults, bool pillarExternal, Dictionary<string, string> pillarSignals,
        HashSet<string> ids, Dictionary<string, string> aliases, List<string> errors, IReadOnlyDictionary<string, DatabaseEngine>? engines = null)
    {
        var dot = s.Id.IndexOf('.');
        if (dot <= 0 || s.Id[..dot] != prefix || !KebabId.IsMatch(s.Id[(dot + 1)..]))
        {
            errors.Add($"{fileName}: id '{s.Id}' must look like '{prefix}.some-name'");
            return null;
        }
        if (!ids.Add(s.Id))
        {
            errors.Add($"{fileName}: id '{s.Id}' is used twice in this town");
            return null;
        }
        foreach (var alias in s.Aliases)
        {
            if (alias == s.Id) errors.Add($"{fileName}: '{s.Id}' lists itself as an alias");
            else if (ids.Contains(alias) || !aliases.TryAdd(alias, s.Id))
                errors.Add($"{fileName}: alias '{alias}' of '{s.Id}' is already taken by another system");
        }

        if (!TryParseKind(s.Role, s.Id, fileName, errors, out var kind)) return null;
        if (s.ServiceCode is { } code && code.Trim().Length == 0) errors.Add($"{fileName}: serviceCode of '{s.Id}' is empty; leave it out to use the service name");
        if (s.Telemetry?.Role is { } telemetryRole && telemetryRole.Trim().Length == 0) errors.Add($"{fileName}: telemetry.role of '{s.Id}' is empty; leave it out to derive it from the environment");
        CheckSignals(s.Signals, $"'{s.Id}'", fileName, errors);
        if (s.TenantPattern is not null)
        {
            if (kind != NodeKind.Database)
                errors.Add($"{fileName}: '{s.Id}' has a tenantPattern, but only a database (role: db) keeps one database per tenant");
            else if (s.TenantPattern.Split(RegistryEnvironment.TenantToken).Length != 2)
                errors.Add($"{fileName}: tenantPattern '{s.TenantPattern}' of '{s.Id}' must contain {RegistryEnvironment.TenantToken} exactly once, where the tenant id goes (for example merchant-{{tenant}}-db)");
        }
        if (s.Engine is { } engineId)
        {
            if (kind != NodeKind.Database)
                errors.Add($"{fileName}: '{s.Id}' has an engine, but only a database (role: db) runs on one");
            else if (engines is null || engines.Count == 0)
                errors.Add($"{fileName}: '{s.Id}' says engine '{engineId}', but town.yaml defines no databaseEngines. List the engines there first");
            else if (!engines.ContainsKey(engineId))
                errors.Add($"{fileName}: engine '{engineId}' of '{s.Id}' is not in town.yaml databaseEngines.{DidYouMean.Hint(engineId, engines.Keys)} Known engines: {string.Join(", ", engines.Keys)}");
        }
        var role = kind == NodeKind.Database ? "db" : kind.ToString().ToLowerInvariant(); // the YAML spelling
        RoleDefaultsFile? app = null, pillar = null;
        foreach (var spelling in kind == NodeKind.Function ? new[] { role, "cron" } : [role]) // a function's defaults may still be written under its old name, cron
        {
            if (app is null) appDefaults.TryGetValue(spelling, out app);
            if (pillar is null) pillarDefaults.TryGetValue(spelling, out pillar);
        }

        var origins = new Dictionary<string, SettingOrigin>();
        double Resolve(string key, Func<RoleDefaultsFile?, double?> pick, double? own)
        {
            if (own is { } mine) { origins[key] = new SettingOrigin(SettingLayer.System, fileName); return mine; }
            if (pick(pillar) is { } fromPillar) { origins[key] = new SettingOrigin(SettingLayer.Pillar, fileName); return fromPillar; }
            if (pick(app) is { } fromApp) { origins[key] = new SettingOrigin(SettingLayer.App, "defaults.yaml"); return fromApp; }
            origins[key] = new SettingOrigin(SettingLayer.BuiltIn, null);
            return pick(BuiltIn)!.Value;
        }

        bool ResolveFlag(string key, Func<RoleDefaultsFile?, bool?> pick, bool? own, bool fallback)
        {
            if (own is { } mine) { origins[key] = new SettingOrigin(SettingLayer.System, fileName); return mine; }
            if (pick(pillar) is { } fromPillar) { origins[key] = new SettingOrigin(SettingLayer.Pillar, fileName); return fromPillar; }
            if (pick(app) is { } fromApp) { origins[key] = new SettingOrigin(SettingLayer.App, "defaults.yaml"); return fromApp; }
            origins[key] = new SettingOrigin(SettingLayer.BuiltIn, null);
            return fallback;
        }

        double? OptionalNumber(Func<RoleDefaultsFile?, double?> pick, double? own) => own ?? pick(pillar) ?? pick(app);

        origins["role"] = new SettingOrigin(SettingLayer.System, fileName);
        origins["external"] = s.External is not null ? new SettingOrigin(SettingLayer.System, fileName)
            : pillarExternal ? new SettingOrigin(SettingLayer.Pillar, fileName)
            : new SettingOrigin(SettingLayer.BuiltIn, null);

        return new RegistryNode(
            s.Id,
            s.Name ?? s.Id[(dot + 1)..],
            groupId,
            kind,
            s.Service,
            s.External ?? pillarExternal,
            Resolve("slaP99Ms", d => d?.SlaP99Ms, s.SlaP99Ms),
            Resolve("errors.amber", d => d?.Errors?.Amber, s.Errors?.Amber),
            Resolve("errors.red", d => d?.Errors?.Red, s.Errors?.Red),
            Resolve("resources.amber", d => d?.Resources?.Amber, s.Resources?.Amber),
            Resolve("resources.red", d => d?.Resources?.Red, s.Resources?.Red),
            Resolve("throttle.amber", d => d?.Throttle?.Amber, s.Throttle?.Amber),
            Resolve("throttle.red", d => d?.Throttle?.Red, s.Throttle?.Red),
            Resolve("backlog.amber", d => d?.Backlog?.Amber, s.Backlog?.Amber),
            Resolve("backlog.red", d => d?.Backlog?.Red, s.Backlog?.Red),
            s.Calls)
        {
            MinCalls = Math.Max(1, (int)Resolve("minCalls", d => d?.MinCalls, s.MinCalls)),
            BacklogCountAmber = OptionalNumber(d => d?.BacklogCount?.Amber, s.BacklogCount?.Amber),
            BacklogCountRed = OptionalNumber(d => d?.BacklogCount?.Red, s.BacklogCount?.Red),
            DiscoverLinks = ResolveFlag("discoverLinks", d => d?.DiscoverLinks, s.DiscoverLinks, true),
            GatewayCalls = s.GatewayCalls,
            ServiceCode = s.ServiceCode,
            TelemetryRole = s.Telemetry?.Role,
            TenantPattern = s.TenantPattern,
            Engine = s.Engine,
            Environments = s.Environments,
            Signals = Merge(pillarSignals, s.Signals),
            SourceFile = fileName,
            Origins = origins,
        };
    }

    private static IReadOnlyDictionary<string, string> Merge(Dictionary<string, string> pillar, Dictionary<string, string> system) =>
        pillar.Concat(system).GroupBy(kv => kv.Key).ToDictionary(g => g.Key, g => g.Last().Value);

    /// <summary>A signal override must name a known signal and a kebab-case source, or none. Whether the source exists is for each environment to say, so that is not checked here.</summary>
    private static void CheckSignals(Dictionary<string, string> signals, string owner, string fileName, List<string> errors)
    {
        foreach (var (signal, source) in signals)
        {
            if (!Signals.Known.Contains(signal))
                errors.Add($"{fileName}: {owner} has signals.{signal}, which is not a signal. Use {string.Join(", ", Signals.Known)}.{DidYouMean.Hint(signal, Signals.Known)}");
            if (source != Signals.None && !KebabId.IsMatch(source))
                errors.Add($"{fileName}: {owner} points signals.{signal} at '{source}'; use a source name from the environment files (lowercase kebab-case) or {Signals.None}");
        }
    }

    private static bool TryParseKind(string? role, string id, string fileName, List<string> errors, out NodeKind kind)
    {
        kind = default;
        if (role is null)
        {
            errors.Add($"{fileName}: '{id}' needs a role (role inference arrives with telemetry)");
            return false;
        }
        var parsed = role.ToLowerInvariant() switch
        {
            "api" => NodeKind.Api,
            "worker" => NodeKind.Worker,
            "db" or "database" => NodeKind.Database,
            "cache" => NodeKind.Cache,
            "function" or "cron" => NodeKind.Function, // cron is the old spelling and stays accepted
            "gateway" => NodeKind.Gateway,
            "broker" => NodeKind.Broker,
            "egress" => NodeKind.Egress,
            _ => (NodeKind?)null,
        };
        if (parsed is null)
        {
            errors.Add($"{fileName}: '{id}' has unknown role '{role}'. Use {RoleList}.{DidYouMean.Hint(role, Roles)}");
            return false;
        }
        kind = parsed.Value;
        return true;
    }
}
