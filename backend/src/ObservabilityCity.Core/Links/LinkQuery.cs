using System.Globalization;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Links;

/// <summary>A source that can answer the link discovery query (the Log Analytics adapter does). The runner never learns which cloud is behind it.</summary>
public interface IDependencySource
{
    /// <summary>False for a source that cannot be asked (a recorded answer kept for trying metrics offline), so no discovery is started for it.</summary>
    bool CanReadDependencies { get; }

    /// <summary>Sends the discovery query for the telemetry names in <paramref name="roles"/> over [<paramref name="from"/>, <paramref name="to"/>) and returns one row for each caller and address.</summary>
    Task<IReadOnlyList<DependencyRow>> ReadDependenciesAsync(Registry.Registry registry, string query, IReadOnlyCollection<string> roles, DateTimeOffset from, DateTimeOffset to, CancellationToken ct);
}

/// <summary>
/// A source that can say how busy each API was on average over a longer stretch, by asking again with the same query it polls with. The traffic runner uses it
/// once at the start so the outside share is steady from the first minute, instead of waiting for the town to have watched for ten.
/// </summary>
public interface IRateHistory
{
    /// <summary>False for a source that cannot be asked (a recorded answer).</summary>
    bool CanReadRates { get; }

    /// <summary>The average requests per second of each system the source reads, over the last <paramref name="window"/>, by system id.</summary>
    Task<IReadOnlyDictionary<string, double>> ReadAverageRatesAsync(Registry.Registry registry, TimeSpan window, CancellationToken ct);
}

/// <summary>
/// The variables the discovery query template may use, besides the scope variables and {environment}: {roles} (the telemetry names of the systems asked
/// about, double-quoted and separated by commas), {from} and {to} (UTC, ISO 8601). The query returns one row for each caller and address with the
/// columns <c>caller</c> (a telemetry name), <c>host</c> and <c>days</c> (the days it was seen on); <c>path</c> and <c>calls</c> may be left out.
/// </summary>
public static class LinkQuery
{
    public const string From = "from";
    public const string To = "to";
    public static readonly string[] Variables = [SourceQuery.Roles, From, To];
    public static readonly string[] Columns = ["caller", "host", "days", "path", "calls"];

    public static string Render(string template, string environmentId, ScopeRules rules, IEnumerable<string> roles, DateTimeOffset from, DateTimeOffset to)
    {
        var quoted = string.Join(", ", roles.Select(r => "\"" + r.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""));
        return ScopeTemplate.Render(template, name => name switch
        {
            SourceQuery.Roles => quoted,
            From => Iso(from),
            To => Iso(to),
            ScopeRules.EnvironmentVariable => environmentId,
            _ => rules.Variables.GetValueOrDefault(name),
        });
    }

    public static string Iso(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
}
