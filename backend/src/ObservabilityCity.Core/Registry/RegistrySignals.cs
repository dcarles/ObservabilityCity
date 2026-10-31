using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Registry;

public sealed partial record Registry
{
    /// <summary>
    /// The source a signal of a system comes from in this environment, or null when it has none. The first of these that answers wins: the system's
    /// own <c>signals</c>, its pillar's, the environment's (not for a third party's building, which only its own entry can give a source), then the environment's source called metrics (or messaging for the queue signals).
    /// A source that is named but not defined by the environment gives nothing. In a demo town the fake source fills whatever nothing else does;
    /// in a live town nothing does, so the signal is absent.
    /// </summary>
    public string? SourceFor(RegistryNode node, string signal)
    {
        var env = ActiveEnvironment;
        // a third party's building is not one the town's sources measure: the environment's choices are for the town's own systems
        var isVendor = node.GroupId == RegistryVendor.GroupId;
        var named = node.Signals.GetValueOrDefault(signal) ?? (isVendor ? null : env?.Signals.GetValueOrDefault(signal));
        if (isVendor && named is null) return Town.IsDemo ? SourceKinds.Fake : null;
        var chosen = named ?? Signals.DefaultSourceName(signal);
        if (chosen == Signals.None) return null;
        if (env?.Sources.Any(s => s.Name == chosen) == true) return chosen;
        // nothing defines it; only a demo town has something to fill a gap nobody asked for
        return named is null && Town.IsDemo ? SourceKinds.Fake : null;
    }

    /// <summary>The signals of a system that no source supplies. The town leaves them out: they are not zero and not grey, they are not there.</summary>
    public IReadOnlyList<string> AbsentSignals(RegistryNode node) =>
        Signals.All.Where(signal => SourceFor(node, signal) is null).ToList();

    /// <summary>Sources an environment defines but no signal reads: probably a typo in a signal's source name or a leftover.</summary>
    internal IEnumerable<string> UnusedSourceWarnings(RegistryEnvironment env) =>
        env.Sources.Where(s => s.Name is not ("metrics" or "incidents" or "messaging")
                               && !env.Signals.Values.Contains(s.Name) && !AllNodes.Any(n => n.Signals.Values.Contains(s.Name)))
            .Select(s => $"Environment '{env.Id}' defines source '{s.Name}', but no signal uses it. Point a signal at it in environments/{env.Id}.yaml, a pillar or a system, or remove it.");

    /// <summary>A signal override that names a source the environment does not define: the signal is absent there.</summary>
    internal IEnumerable<string> UnknownSourceWarnings(RegistryEnvironment env) =>
        AllNodes.SelectMany(n => n.Signals.Where(kv => kv.Value != Signals.None && env.Sources.All(s => s.Name != kv.Value))
            .Select(kv => $"{n.SourceFile}: {n.Id} takes {kv.Key} from source '{kv.Value}', which environment '{env.Id}' does not define, so {kv.Key} is absent there."));
}
