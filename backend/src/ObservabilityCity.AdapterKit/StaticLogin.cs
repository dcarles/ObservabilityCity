using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.AdapterKit;

/// <summary>A login that gives the same token to anyone, and remembers the scopes it was asked for. For adapters that sign in.</summary>
public sealed class StaticLogin(string token = "test-token") : ICredentialSource
{
    private readonly List<string> _scopes = [];
    public IReadOnlyList<string> Scopes => _scopes;

    public Task<string> GetTokenAsync(string scope, CancellationToken ct)
    {
        _scopes.Add(scope);
        return Task.FromResult(token);
    }
}
