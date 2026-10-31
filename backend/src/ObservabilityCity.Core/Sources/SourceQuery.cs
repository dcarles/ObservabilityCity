using System.Globalization;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// What a source that sends a query (a source with <c>query</c> and <c>window</c> in its environment definition) needs to turn the template into
/// the query it sends: how far back it looks and the variables it can use. The query is the company's; the program fills in only these holes.
/// </summary>
public static class SourceQuery
{
    public const string DefaultWindow = "5m";
    public const string Window = "window";
    public const string WindowSeconds = "windowSeconds";
    public const string Roles = "roles";

    /// <summary>The variables a query template may use besides the scope variables and {environment}.</summary>
    public static readonly string[] Variables = [Window, WindowSeconds, Roles];

    /// <summary>A number and a unit: 30s, 5m, 1h, 7d.</summary>
    public static bool TryParseWindow(string text, out TimeSpan window)
    {
        window = default;
        var t = text.Trim();
        if (t.Length < 2 || !double.TryParse(t[..^1], NumberStyles.Float, CultureInfo.InvariantCulture, out var n) || n <= 0) return false;
        switch (t[^1])
        {
            case 's': window = TimeSpan.FromSeconds(n); return true;
            case 'm': window = TimeSpan.FromMinutes(n); return true;
            case 'h': window = TimeSpan.FromHours(n); return true;
            case 'd': window = TimeSpan.FromDays(n); return true;
            default: return false;
        }
    }

    public static TimeSpan WindowOf(RegistrySource source) =>
        TryParseWindow(source.Window ?? DefaultWindow, out var window) ? window : throw new InvalidOperationException($"the window '{source.Window}' is not a number and a unit like 5m");

    /// <summary>The query with every hole filled. <paramref name="roles"/> are written as double-quoted strings separated by commas.</summary>
    public static string Render(string template, RegistrySource source, string environmentId, ScopeRules rules, IEnumerable<string> roles)
    {
        var window = WindowOf(source);
        var quoted = string.Join(", ", roles.Select(r => "\"" + r.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""));
        return ScopeTemplate.Render(template, name => name switch
        {
            Window => (source.Window ?? DefaultWindow).Trim(),
            WindowSeconds => ((long)Math.Round(window.TotalSeconds)).ToString(CultureInfo.InvariantCulture),
            Roles => quoted,
            ScopeRules.EnvironmentVariable => environmentId,
            _ => rules.Variables.GetValueOrDefault(name),
        });
    }
}
