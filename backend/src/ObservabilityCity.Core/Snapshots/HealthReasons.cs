using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>
/// The short line that says why a system is amber or red. It is built from the same readings and the same thresholds that decided the state in
/// <see cref="SnapshotBuilder"/>, so the words and the colour can never disagree. Nothing here knows a company's names.
/// </summary>
internal static class HealthReasons
{
    internal static string? For(RuleInput input)
    {
        var parts = DegradedRules.Reasons(input).ToList();
        return parts.Count == 0 ? null : string.Join(", ", parts);
    }
}
