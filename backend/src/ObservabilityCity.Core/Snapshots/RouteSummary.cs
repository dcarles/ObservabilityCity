using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>What a system's measured routes become in the snapshot: the busiest few, and the split by method worked out from all of them.</summary>
public static class RouteSummary
{
    /// <summary>How many routes a system's snapshot lists.</summary>
    public const int Top = 5;

    /// <summary>The busiest routes, highest rate first. A route seen under two spellings of its method (get, GET) counts once. Null when the source measured none.</summary>
    public static IReadOnlyList<RouteSnapshot>? TopRoutes(IReadOnlyList<RouteReading>? routes)
    {
        if (routes is not { Count: > 0 }) return null;
        var joined = routes
            .Where(r => r.PerSecond > 0)
            .GroupBy(r => (Method: r.Method.Trim().ToUpperInvariant(), Route: r.Route.Trim()))
            .Select(g =>
            {
                var rate = g.Sum(r => r.PerSecond);
                return new RouteSnapshot(g.Key.Method, g.Key.Route, rate, rate > 0 ? Math.Clamp(g.Sum(r => r.PerSecond * r.ErrorRate) / rate, 0, 1) : 0);
            })
            .OrderByDescending(r => r.PerSecond).ThenBy(r => r.Route, StringComparer.Ordinal).ThenBy(r => r.Method, StringComparer.Ordinal)
            .Take(Top)
            .ToList();
        return joined.Count == 0 ? null : joined;
    }

    /// <summary>The requests of each method and its share of all, highest first. Null when nothing was measured.</summary>
    public static IReadOnlyList<MethodSnapshot>? ByMethod(IReadOnlyList<RouteReading>? routes)
    {
        if (routes is not { Count: > 0 }) return null;
        var perMethod = routes.Where(r => r.PerSecond > 0).GroupBy(r => r.Method.Trim().ToUpperInvariant()).Select(g => (Method: g.Key, Rate: g.Sum(r => r.PerSecond))).ToList();
        var total = perMethod.Sum(m => m.Rate);
        if (total <= 0) return null;
        return perMethod.OrderByDescending(m => m.Rate).ThenBy(m => m.Method, StringComparer.Ordinal).Select(m => new MethodSnapshot(m.Method, m.Rate, m.Rate / total)).ToList();
    }
}
