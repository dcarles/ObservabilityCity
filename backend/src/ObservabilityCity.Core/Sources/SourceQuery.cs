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
    /// <summary>For the hourly query of a job source only: the start of the hour being read, written as a KQL datetime (<c>datetime(2026-11-20T03:00:00Z)</c>).</summary>
    public const string RangeStart = "rangeStart";

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

    /// <summary>A span written the way a query template reads it: whole seconds, minutes, hours or days (<c>3600s</c> is written <c>1h</c>).</summary>
    public static string Text(TimeSpan span)
    {
        var s = (long)Math.Round(span.TotalSeconds);
        if (s % 86400 == 0) return $"{s / 86400}d";
        if (s % 3600 == 0) return $"{s / 3600}h";
        if (s % 60 == 0) return $"{s / 60}m";
        return $"{s}s";
    }

    /// <summary>
    /// A rendered query moved to a past time: <c>ago(x)</c> becomes <c>(datetime(at) - (x))</c> and <c>now()</c> becomes <c>datetime(at)</c>, so a query written for "the last window"
    /// reads the window that ended at <paramref name="at"/>. Only those two ways of saying "now" are known; a query with another (a hard-coded time, or a time taken from a table) is read as written.
    /// </summary>
    public static string AtPast(string rendered, DateTimeOffset at)
    {
        var moment = $"datetime({at.UtcDateTime:yyyy-MM-dd'T'HH:mm:ss'Z'})";
        var moved = System.Text.RegularExpressions.Regex.Replace(rendered, @"\bago\s*\(([^()]*)\)", m => $"({moment} - ({m.Groups[1].Value}))", System.Text.RegularExpressions.RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
        return System.Text.RegularExpressions.Regex.Replace(moved, @"\bnow\s*\(\s*\)", moment, System.Text.RegularExpressions.RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
    }

    public static TimeSpan WindowOf(RegistrySource source) =>
        TryParseWindow(source.Window ?? DefaultWindow, out var window) ? window : throw new InvalidOperationException($"the window '{source.Window}' is not a number and a unit like 5m");

    /// <summary>The query with every hole filled. <paramref name="roles"/> are written as double-quoted strings separated by commas.</summary>
    public static string Render(string template, RegistrySource source, string environmentId, ScopeRules rules, IEnumerable<string> roles, TimeSpan? over = null, DateTimeOffset? rangeStart = null)
    {
        var window = over ?? WindowOf(source);
        var quoted = string.Join(", ", roles.Select(r => "\"" + r.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""));
        return ScopeTemplate.Render(template, name => name switch
        {
            Window => over is { } o ? Text(o) : (source.Window ?? DefaultWindow).Trim(),
            WindowSeconds => ((long)Math.Round(window.TotalSeconds)).ToString(CultureInfo.InvariantCulture),
            Roles => quoted,
            RangeStart when rangeStart is { } start => $"datetime({start.UtcDateTime:yyyy-MM-dd'T'HH:mm:ss'Z'})",
            ScopeRules.EnvironmentVariable => environmentId,
            _ => rules.Variables.GetValueOrDefault(name),
        });
    }
}
