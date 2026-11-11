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
        // what each kind can serve besides signals: the core asks for these, never for a kind's name. The adapter reads and checks its sources' own keys
        foreach (var (kind, can) in new[]
                 {
                     (ResourceGraphSourceFactory.SourceKind, SourceCapabilities.Inventory),
                     (LogAnalyticsSourceFactory.SourceKind, SourceCapabilities.Logs | SourceCapabilities.Links),
                     (AzureMonitorSourceFactory.SourceKind, SourceCapabilities.None),
                     (ServiceBusSourceFactory.SourceKind, SourceCapabilities.None),
                     (FunctionJobsSourceFactory.SourceKind, SourceCapabilities.None),
                     (ResourceHealthSourceFactory.SourceKind, SourceCapabilities.HealthEvents),
                 })
            registry.AddSourceKind(new SourceKindInfo(kind, LoginKind) { Capabilities = can, Settings = AzureSourceSettings.Reader }); // every Azure kind takes the same settings keys
        registry.AddSource(new ResourceGraphSourceFactory());
        registry.AddSource(new LogAnalyticsSourceFactory());
        registry.AddSource(new AzureMonitorSourceFactory());
        registry.AddSource(new ServiceBusSourceFactory());
        registry.AddSource(new FunctionJobsSourceFactory());
        registry.AddSource(new ResourceHealthSourceFactory());
        foreach (var login in new AzureLogin[] { new AzureCliLogin(), new AzureDefaultLogin(), new AzureManagedIdentityLogin(), new AzureServicePrincipalLogin() })
            registry.AddCredentialKind(login);
    }
}
