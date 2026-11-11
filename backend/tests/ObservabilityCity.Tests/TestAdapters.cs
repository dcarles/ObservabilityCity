using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>The adapter modules a test loads a town with, so each checks its own sources' settings as the host and the validator have it do.</summary>
internal static class TestAdapters
{
    public static AdapterCatalog Azure { get; } = new([new AzureAdapters()]);
}
