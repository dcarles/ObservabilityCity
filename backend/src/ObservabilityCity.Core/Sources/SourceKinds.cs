namespace ObservabilityCity.Core.Sources;

/// <summary>The kinds of source an environment file may name, and the logins they take. An adapter for a kind may arrive later than its name.</summary>
public static class SourceKinds
{
    public const string Fake = "fake";

    /// <summary>Kinds that read from Azure with an Azure login (<see cref="CredentialKinds"/>).</summary>
    public static readonly string[] Azure = ["resourcegraph", "loganalytics", "azuremonitor", "servicebus"];

    public static readonly string[] All = [Fake, .. Azure, "prometheus", "grafana-irm"];

    public static bool UsesAzureLogin(string kind) => Azure.Contains(kind);
}

/// <summary>The ways an Azure source can sign in. Which one is chosen is configuration; the default is whoever is signed in to the Azure CLI.</summary>
public static class CredentialKinds
{
    /// <summary>The account <c>az login</c> signed in. The default.</summary>
    public const string AzureCli = "azure-cli";
    /// <summary>The Azure SDK's usual chain (environment, managed identity, developer tools).</summary>
    public const string Default = "default";
    public const string ManagedIdentity = "managed-identity";
    /// <summary>An app registration. Its secret is read from the environment variable named by clientSecretEnv, never from a file.</summary>
    public const string ServicePrincipal = "service-principal";

    public static readonly string[] All = [AzureCli, Default, ManagedIdentity, ServicePrincipal];

    /// <summary>The login a source uses when it names none.</summary>
    public const string ImplicitName = "default";
}
