using Azure.Core;
using Azure.Identity;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// Makes the login an environment file describes. Making one signs nobody in: the token is asked for when an adapter first needs it, so a
/// town can start before <c>az login</c> and a missing login only costs the signals that need it.
/// </summary>
public sealed class AzureCredentialFactory(Func<string, string?>? environmentVariable = null) : ICredentialFactory
{
    private readonly Func<string, string?> _env = environmentVariable ?? Environment.GetEnvironmentVariable;

    public ICredentialSource Create(RegistryCredential credential) => new TokenCredentialSource(Credential(credential));

    /// <summary>Throws <see cref="InvalidOperationException"/> when the description cannot be made into a login (an unknown kind, a secret variable that is not set).</summary>
    public TokenCredential Credential(RegistryCredential c)
    {
        switch (c.Kind)
        {
            case CredentialKinds.AzureCli:
                return new AzureCliCredential(new AzureCliCredentialOptions { TenantId = c.TenantId });
            case CredentialKinds.Default:
                return new DefaultAzureCredential(new DefaultAzureCredentialOptions { TenantId = c.TenantId });
            case CredentialKinds.ManagedIdentity:
                return new ManagedIdentityCredential(c.ClientId is { } id ? ManagedIdentityId.FromUserAssignedClientId(id) : ManagedIdentityId.SystemAssigned);
            case CredentialKinds.ServicePrincipal:
                var variable = c.ClientSecretEnv ?? throw new InvalidOperationException($"credential '{c.Name}' names no clientSecretEnv");
                var secret = _env(variable);
                if (string.IsNullOrEmpty(secret)) throw new InvalidOperationException($"credential '{c.Name}' reads its secret from the environment variable {variable}, which is not set");
                return new ClientSecretCredential(c.TenantId ?? throw new InvalidOperationException($"credential '{c.Name}' needs a tenantId"), c.ClientId ?? throw new InvalidOperationException($"credential '{c.Name}' needs a clientId"), secret);
            default:
                throw new InvalidOperationException($"credential '{c.Name}' has kind '{c.Kind}', which is not one of {string.Join(", ", CredentialKinds.All)}");
        }
    }
}

/// <summary>A login seen as the core sees it: a token for a scope.</summary>
public sealed class TokenCredentialSource(TokenCredential credential) : ICredentialSource
{
    public TokenCredential Credential { get; } = credential;

    public async Task<string> GetTokenAsync(string scope, CancellationToken ct) =>
        (await credential.GetTokenAsync(new TokenRequestContext([scope]), ct)).Token;
}
