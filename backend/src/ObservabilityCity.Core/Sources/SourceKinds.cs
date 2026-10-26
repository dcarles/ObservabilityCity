namespace ObservabilityCity.Core.Sources;

/// <summary>The one source kind the core itself knows. Every other kind is added by an adapter module (see <see cref="IAdapterModule"/>).</summary>
public static class SourceKinds
{
    public const string Fake = "fake";
}
