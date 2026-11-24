namespace ObservabilityCity.Core.Apis;

/// <summary>
/// Where the API explorer reads from (<c>apis:</c> in the environment file). <see cref="Source"/> names a source of the same file whose kind can read APIs (its connection and login are reused);
/// <see cref="Gateway"/> is the id of the system whose resources are the gateways (the resources the scope rules find for it, one for each region); <see cref="Merge"/> says the gateways are copies of
/// one another (resilience), so an API they share is listed once and a difference between them is marked; <see cref="ResourceHosts"/> are address templates with <c>{name}</c> that say how a resource's
/// own address is built, so a backend that is one of the town's own resources (a web app's default address) is matched to its system; <see cref="CacheFor"/> is how long a read is kept.
/// The backend address is first matched with the environment's <c>links</c> rules and the third parties' domains, the same rules link discovery uses.
/// </summary>
public sealed record ApiCatalogueConfig(string Source, string Gateway, bool Merge, IReadOnlyList<string> ResourceHosts, TimeSpan CacheFor)
{
    public static readonly TimeSpan DefaultCacheFor = TimeSpan.FromHours(1);
}
