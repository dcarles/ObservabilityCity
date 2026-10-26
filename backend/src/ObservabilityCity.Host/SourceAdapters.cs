using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Host;

/// <summary>
/// The source adapters this build has. Each real adapter adds its factory here when it lands; a fork adds its own from extensions/. A source kind with no
/// factory is reported at start-up and its signals show no data.
/// </summary>
public static class SourceAdapters
{
    public static IReadOnlyList<IMetricSourceFactory> Factories { get; } = [];
}
