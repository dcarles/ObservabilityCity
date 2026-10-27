using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// Everything for Azure: the kinds of source that read it and the ways to sign in. The host finds this module in <c>adapters/azure/</c>; a build
/// without that folder knows nothing of Azure. Each source adapter registers its factory here as it lands.
/// </summary>
public sealed class AzureAdapters : IAdapterModule
{
    public const string LoginKind = "azure-cli";

    public string Name => "azure";

    public void Register(IAdapterRegistry registry)
    {
        foreach (var kind in new[] { "resourcegraph", "loganalytics", "azuremonitor", "servicebus" })
            registry.AddSourceKind(new SourceKindInfo(kind, LoginKind));
        registry.AddSource(new ResourceGraphSourceFactory());
        registry.AddSource(new LogAnalyticsSourceFactory());
        foreach (var login in new AzureLogin[] { new AzureCliLogin(), new AzureDefaultLogin(), new AzureManagedIdentityLogin(), new AzureServicePrincipalLogin() })
            registry.AddCredentialKind(login);
    }
}
