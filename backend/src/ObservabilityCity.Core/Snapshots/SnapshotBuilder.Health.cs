using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Health reports, incidents and how fresh each source is. Part of <see cref="SnapshotBuilder"/>.</summary>
public sealed partial class SnapshotBuilder
{
    /// <summary>
    /// The cloud's health events (open, then recently resolved), each tied to the building that owns the resource (by the resource's id, case aside, through the resources the scope rules found for each system)
    /// and that building's island. A resource no system owns stays in the list without either. Worst first (Unavailable before Degraded), then the oldest.
    /// </summary>
    private List<HealthEventSnapshot> HealthEventsOf(Registry.Registry registry)
    {
        var resolution = ScopeSource?.Resolve(registry);
        var owner = new Dictionary<string, (string SystemId, string Name, string? Tenant)>(StringComparer.OrdinalIgnoreCase);
        var tenantNames = resolution?.TenantNames.ToDictionary(t => t.Id, t => t.Name, StringComparer.OrdinalIgnoreCase) ?? [];
        if (resolution is not null)
            foreach (var system in resolution.Systems)
                foreach (var resource in system.Resources)
                    owner.TryAdd(resource.Id, (system.SystemId, resource.Name, resource.Tenant is { } t ? tenantNames.GetValueOrDefault(t) ?? t : null));
        var groupOf = registry.Groups.SelectMany(g => g.Nodes.Select(n => (Node: n.Id, Group: g.Id))).GroupBy(x => x.Node).ToDictionary(g => g.Key, g => g.First().Group);
        var all = new List<HealthEventSnapshot>();
        foreach (var source in HealthSources)
            foreach (var e in source.Current())
            {
                var found = owner.TryGetValue(e.ResourceId, out var own);
                var node = found && groupOf.ContainsKey(own.SystemId) ? own.SystemId : null;
                all.Add(new HealthEventSnapshot(e.Id, found ? own.Name : e.ResourceName, e.State, e.Previous, e.Cause, e.Since, node, node is null ? null : groupOf[node], e.Summary, e.ResolvedAt, found ? own.Tenant : null));
            }
        // open ones first (Unavailable before Degraded, oldest first), then the resolved ones, the latest resolution first
        return all.OrderBy(e => e.State == "Resolved" ? 2 : e.State == "Unavailable" ? 0 : 1).ThenBy(e => e.State == "Resolved" ? 0 : e.Since.Ticks).ThenByDescending(e => e.ResolvedAt).ThenBy(e => e.Id, StringComparer.Ordinal).ToList();
    }

    /// <summary>One line per configured source: when it last reported, how often it is asked, and whether it is overdue by the limit that greys a building.</summary>
    private IReadOnlyList<SourceFreshnessSnapshot>? SourceFreshness(DateTimeOffset now)
    {
        if (SourceIntervals.Count == 0) return null;
        return SourceIntervals.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv =>
        {
            var last = state.LastReadOf(kv.Key);
            var overdue = now - (last ?? _startedAt) > FreshFor(kv.Key);
            return new SourceFreshnessSnapshot(kv.Key, last, kv.Value.TotalSeconds, overdue);
        }).ToList();
    }

    /// <summary>Remembers when each island last had an open incident. Every full build calls this, so the memory does not depend on who is looking.</summary>
    private void NoteIncidents(IEnumerable<string> groupsWithIncidents, DateTimeOffset now)
    {
        lock (_incidentGate)
            foreach (var id in groupsWithIncidents) _lastIncident[id] = now;
    }

    /// <summary>For the islands on screen: since when none has had an incident (null while one is open), and whether any has had one since the server started.</summary>
    private (DateTimeOffset? FreeSince, bool Seen) IncidentHistory(IEnumerable<string> shown, bool openNow)
    {
        lock (_incidentGate)
        {
            var times = shown.Where(_lastIncident.ContainsKey).Select(id => _lastIncident[id]).ToList();
            if (openNow) return (null, true);
            return (times.Count > 0 ? times.Max() : _startedAt, times.Count > 0);
        }
    }

    /// <summary>Open incidents per group, worst first. Incidents for a group the registry lacks are dropped.</summary>
    private Dictionary<string, IReadOnlyList<IncidentSnapshot>> OpenIncidents(Registry.Registry registry)
    {
        var known = registry.Groups.Select(g => g.Id).ToHashSet();
        return IncidentSources
            .SelectMany(src => src.Current(registry))
            .Where(i => known.Contains(i.GroupId))
            .GroupBy(i => i.GroupId)
            .ToDictionary(
                g => g.Key,
                g => (IReadOnlyList<IncidentSnapshot>)g.OrderBy(i => i.Severity).ThenBy(i => i.StartedAt)
                    .Select(i => new IncidentSnapshot(i.Id, i.Title, Math.Clamp(i.Severity, 1, 4), i.StartedAt)).ToList());
    }
}
