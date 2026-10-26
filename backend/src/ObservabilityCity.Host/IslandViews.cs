namespace ObservabilityCity.Host;

/// <summary>
/// Which island filters the connected browsers are looking through, for each environment. A browser that asks for some islands is in a group of its
/// own filter, and each snapshot tick builds one filtered snapshot for every filter in use, not one for every browser.
/// </summary>
public sealed class IslandViews
{
    private readonly object _gate = new();
    private readonly Dictionary<(string Env, string Key), (IReadOnlyList<string> Islands, int Viewers)> _active = new();

    /// <summary>The island ids as written in an address or sent by a browser (commas and spaces round them), without blanks and repeats, in a fixed order.</summary>
    public static IReadOnlyList<string> Parse(IEnumerable<string>? raw) =>
        (raw ?? []).SelectMany(r => r.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)).Distinct().Order(StringComparer.Ordinal).ToList();

    /// <summary>The SignalR group of the browsers looking at this environment through this filter. No filter is the environment's own group.</summary>
    public static string GroupOf(string env, IReadOnlyList<string> islands) => islands.Count == 0 ? env : $"{env}|{string.Join(',', islands)}";

    /// <summary>Counts a browser in. Returns its group.</summary>
    public string Join(string env, IReadOnlyList<string> islands)
    {
        var key = GroupOf(env, islands);
        if (islands.Count == 0) return key;
        lock (_gate)
            _active[(env, key)] = (islands, _active.TryGetValue((env, key), out var v) ? v.Viewers + 1 : 1);
        return key;
    }

    /// <summary>Counts a browser out of the group it was in.</summary>
    public void Leave(string env, IReadOnlyList<string> islands)
    {
        if (islands.Count == 0) return;
        var key = GroupOf(env, islands);
        lock (_gate)
        {
            if (!_active.TryGetValue((env, key), out var v)) return;
            if (v.Viewers <= 1) _active.Remove((env, key));
            else _active[(env, key)] = (v.Islands, v.Viewers - 1);
        }
    }

    /// <summary>The filters browsers are looking through in an environment right now.</summary>
    public IReadOnlyList<(string Group, IReadOnlyList<string> Islands)> InUse(string env)
    {
        lock (_gate) return _active.Where(kv => kv.Key.Env == env).Select(kv => (kv.Key.Key, kv.Value.Islands)).ToList();
    }
}
