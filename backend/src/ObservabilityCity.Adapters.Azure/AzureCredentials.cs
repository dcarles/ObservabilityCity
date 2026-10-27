using System.Collections.Concurrent;
using Azure.Core;
using Azure.Identity;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// One way to sign in to Azure. Making a login signs nobody in: the token is asked for when an adapter first needs it, so a town can start before
/// <c>az login</c> and a missing login only costs the signals that need it.
/// </summary>
public abstract class AzureLogin(Func<string, string?>? environmentVariable = null) : ICredentialKind
{
    protected Func<string, string?> Env { get; } = environmentVariable ?? Environment.GetEnvironmentVariable;

    public abstract string Kind { get; }
    public virtual IEnumerable<string> Check(RegistryCredential credential) =>
        credential.ClientSecretEnv is null ? [] : [$"credential '{credential.Name}' has clientSecretEnv, which only a service-principal uses"];

    public ICredentialSource Create(RegistryCredential credential) => new TokenCredentialSource(Credential(credential));

    /// <summary>Throws <see cref="InvalidOperationException"/> when the description cannot be made into a login.</summary>
    public abstract TokenCredential Credential(RegistryCredential credential);
}

/// <summary>Whoever <c>az login</c> signed in.</summary>
public sealed class AzureCliLogin : AzureLogin
{
    public override string Kind => "azure-cli";
    public override TokenCredential Credential(RegistryCredential c) => new AzureCliCredential(new AzureCliCredentialOptions { TenantId = c.TenantId });
}

/// <summary>The Azure SDK's usual chain.</summary>
public sealed class AzureDefaultLogin : AzureLogin
{
    public override string Kind => "default";
    public override TokenCredential Credential(RegistryCredential c) => new DefaultAzureCredential(new DefaultAzureCredentialOptions { TenantId = c.TenantId });
}

/// <summary>The identity of the machine it runs on.</summary>
public sealed class AzureManagedIdentityLogin : AzureLogin
{
    public override string Kind => "managed-identity";
    public override TokenCredential Credential(RegistryCredential c) =>
        new ManagedIdentityCredential(c.ClientId is { } id ? ManagedIdentityId.FromUserAssignedClientId(id) : ManagedIdentityId.SystemAssigned);
}

/// <summary>An app registration; its secret is read from the environment variable the entry names.</summary>
public sealed class AzureServicePrincipalLogin(Func<string, string?>? environmentVariable = null) : AzureLogin(environmentVariable)
{
    public override string Kind => "service-principal";

    public override IEnumerable<string> Check(RegistryCredential c) =>
        c.ClientId is null || c.ClientSecretEnv is null
            ? [$"credential '{c.Name}' is a service-principal, which needs clientId and clientSecretEnv (the name of the environment variable that holds the secret)"]
            : [];

    public override TokenCredential Credential(RegistryCredential c)
    {
        var variable = c.ClientSecretEnv ?? throw new InvalidOperationException($"credential '{c.Name}' names no clientSecretEnv");
        var secret = Env(variable);
        if (string.IsNullOrEmpty(secret)) throw new InvalidOperationException($"credential '{c.Name}' reads its secret from the environment variable {variable}, which is not set");
        return new ClientSecretCredential(c.TenantId ?? throw new InvalidOperationException($"credential '{c.Name}' needs a tenantId"), c.ClientId ?? throw new InvalidOperationException($"credential '{c.Name}' needs a clientId"), secret);
    }
}

/// <summary>
/// A login seen as the core sees it: a token for a scope. A token is kept until shortly before it expires and one request per scope runs at a time, so many
/// reads at once share one sign-in. Some logins (the Azure CLI one) start a process for every request, which is slow and can time out when asked many times at once.
/// </summary>
public sealed class TokenCredentialSource(TokenCredential credential, TimeProvider? clock = null, TimeSpan? refreshBefore = null) : ICredentialSource
{
    private sealed record Cached(string Token, DateTimeOffset ExpiresOn);

    private sealed class Entry
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public volatile Cached? Token;
    }

    private readonly TimeProvider time = clock ?? TimeProvider.System;
    private readonly TimeSpan margin = refreshBefore ?? TimeSpan.FromMinutes(5);
    private readonly ConcurrentDictionary<string, Entry> entries = new();

    public TokenCredential Credential { get; } = credential;

    public async Task<string> GetTokenAsync(string scope, CancellationToken ct)
    {
        var entry = entries.GetOrAdd(scope, _ => new Entry());
        if (Fresh(entry) is { } kept) return kept;
        await entry.Gate.WaitAsync(ct);
        try
        {
            if (Fresh(entry) is { } again) return again; // another request got one while this one waited
            var token = await Credential.GetTokenAsync(new TokenRequestContext([scope]), ct);
            entry.Token = new Cached(token.Token, token.ExpiresOn);
            return token.Token;
        }
        finally { entry.Gate.Release(); }
    }

    private string? Fresh(Entry entry) => entry.Token is { } t && t.ExpiresOn - margin > time.GetUtcNow() ? t.Token : null;
}
