using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Scope;

/// <summary>The scope of one system as the inspector shows it.</summary>
public static class ScopeInfos
{
    /// <summary>Null when the environment has no scope rules, so a town that does not use them shows nothing (absent, not empty).</summary>
    public static ScopeInfo? Of(Registry.Registry view, ScopeStore store, string systemId)
    {
        if (view.ActiveEnvironment is not { } env || env.Scope.IsEmpty) return null;
        var resolution = store.Resolve(view);
        if (resolution.System(systemId) is not { } scope) return null;
        var node = view.AllNodes.First(n => n.Id == systemId);
        var pillar = resolution.Pillar(node.GroupId);
        var names = resolution.TenantNames.ToDictionary(t => t.Id, t => t.Name);
        var hasSource = env.Sources.Any(s => s.Kind == "resourcegraph" && (env.Scope.Inventory is null || s.Name == env.Scope.Inventory));
        var state = !hasSource ? "none" : store.Error is not null ? "failed" : store.Inventory is null ? "waiting" : "read";
        var problems = resolution.Problems.Where(p => p.Contains($"'{systemId}'") || p.Contains($"Pillar '{node.GroupId}'") || p.Contains("Log Analytics workspace")).ToList();
        if (store.Error is { } error) problems.Add($"The last inventory read failed: {error}");
        return new ScopeInfo(
            pillar?.SubscriptionName ?? pillar?.SubscriptionId, pillar is { Via.Length: > 0 } ? pillar.Via : null,
            scope.Workspace, resolution.WorkspaceVia, scope.ServiceCode, scope.TelemetryRole, scope.TelemetryRoleVia,
            scope.Resources.Select(r =>
            {
                var tenant = r.Tenant is null ? null : names.GetValueOrDefault(r.Tenant, r.Tenant);
                return new ScopeResource(r.Name, r.Type, r.Region, tenant, r.Instances, ScopeLinks.For(env.Scope, env.Id, r, r.SubscriptionId ?? scope.SubscriptionId, tenant));
            }).ToList(),
            scope.Instances, problems, state);
    }
}
