namespace ObservabilityCity.Core.Registry;

/// <summary>Finds the closest known name to a mistyped one, for error messages.</summary>
internal static class DidYouMean
{
    public static string? Closest(string typed, IEnumerable<string> known)
    {
        string? best = null;
        var bestDistance = int.MaxValue;
        foreach (var k in known)
        {
            var d = Distance(typed.ToLowerInvariant(), k.ToLowerInvariant());
            if (d < bestDistance) { bestDistance = d; best = k; }
        }
        // close enough to be a typo: a third of the length, and never more than three edits
        return best is not null && bestDistance <= Math.Min(3, Math.Max(1, typed.Length / 3)) ? best : null;
    }

    /// <summary>" Did you mean 'x'?" or an empty string.</summary>
    public static string Hint(string typed, IEnumerable<string> known) =>
        Closest(typed, known) is { } c ? $" Did you mean '{c}'?" : "";

    private static int Distance(string a, string b)
    {
        var row = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var diagonal = row[0];
            row[0] = i;
            for (var j = 1; j <= b.Length; j++)
            {
                var above = row[j];
                row[j] = Math.Min(Math.Min(row[j] + 1, row[j - 1] + 1), diagonal + (a[i - 1] == b[j - 1] ? 0 : 1));
                diagonal = above;
            }
        }
        return row[b.Length];
    }
}
