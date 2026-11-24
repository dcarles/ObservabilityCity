using System.Collections.Concurrent;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Core.Apis;

/// <summary>
/// What a demo town (or a test) supplies instead of an environment file's <c>apis</c> block and a resolved scope: the settings, the gateways, and a way to tell a system from a backend address.
/// A live town passes none and everything comes from the file and the scope.
/// </summary>
public sealed record ApiCatalogueOverrides(ApiCatalogueConfig Config, Func<TownRegistry, IReadOnlyList<GatewayRef>> Gateways, Func<string, string?>? HostSystem = null);

/// <summary>
/// The API explorer's data: the APIs of the gateways the environment names, read on demand from a source whose kind can (see <see cref="IApiCatalogueSource"/>), kept for
/// <see cref="ApiCatalogueConfig.CacheFor"/>, matched to the town's systems by their backend address (<see cref="ApiMatcher"/>), and, when the gateways are copies of one another
/// (<c>merge</c>), listed once with a marker where they differ. Policies leave here with anything secret-looking masked (<see cref="PolicyMask"/>). A read that fails is not kept, so the next
/// open tries again. An environment with no <c>apis</c> block answers "not configured". The class knows no cloud.
/// </summary>
public sealed class ApiCatalogue(IRegistryProvider registries, ScopeStore scope, Func<string, IApiCatalogueSource?> sourceNamed, TimeProvider time, ApiCatalogueOverrides? overrides = null)
{
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, Task<object?> Result)> _cache = new(StringComparer.Ordinal);

    private (ApiCatalogueConfig Config, IReadOnlyList<GatewayRef> Gateways, IApiCatalogueSource Source, ApiMatcher Matcher, TownRegistry View, IReadOnlyList<string> Problems)? Start()
    {
        var view = registries.Current;
        var environment = view.ActiveEnvironment;
        var config = overrides?.Config ?? environment?.Apis;
        if (config is null) return null;
        var source = sourceNamed(config.Source) ?? throw new InvalidOperationException($"the apis source '{config.Source}' is not running, or it cannot read APIs");
        var resolution = scope.Resolve(view);
        var problems = new List<string>();
        IReadOnlyList<GatewayRef> gateways;
        if (overrides is not null) gateways = overrides.Gateways(view);
        else
        {
            var system = resolution.System(config.Gateway);
            gateways = system is null ? [] : system.Resources.Select(r => new GatewayRef(r.Id, r.Name, string.IsNullOrWhiteSpace(r.Region) ? r.Name : r.Region!)).ToList();
            if (gateways.Count == 0)
                problems.Add(system is null ? $"No system '{config.Gateway}' to take the gateways from." : $"The system '{config.Gateway}' has no resources yet: the inventory has not been read, or its resource rule finds nothing.");
        }
        return (config, gateways, source, new ApiMatcher(view, environment, config, resolution, overrides?.HostSystem), view, problems);
    }

    /// <summary>One cached read: a task kept for the cache time, dropped when it fails. It runs without the caller's token, so a page that goes away does not cancel what the next one waits for.</summary>
    private Task<T> Cached<T>(string key, TimeSpan keep, Func<Task<T>> read) where T : class?
    {
        var now = time.GetUtcNow();
        if (_cache.TryGetValue(key, out var hit) && now - hit.At < keep) return Unbox<T>(hit.Result);
        var task = Task.Run(async () => (object?)await read());
        _cache[key] = (now, task);
        task.ContinueWith(t => { if (t.IsFaulted || t.IsCanceled) _cache.TryRemove(new KeyValuePair<string, (DateTimeOffset, Task<object?>)>(key, (now, task))); }, TaskScheduler.Default);
        return Unbox<T>(task);
    }

    private static async Task<T> Unbox<T>(Task<object?> task) where T : class? => (T)(await task)!;

    /// <summary>Every API of the environment's gateways, each matched, for the explorer's tree.</summary>
    public async Task<ApiCatalogueList> ListAsync(CancellationToken ct)
    {
        if (Start() is not { } s) return new ApiCatalogueList(time.GetUtcNow(), false, [], []);
        var problems = s.Problems.ToList();
        var perGateway = new List<(GatewayRef Gateway, IReadOnlyList<SourceApi> Apis)>();
        foreach (var gateway in s.Gateways)
        {
            try { perGateway.Add((gateway, await Cached($"list|{s.Source.Name}|{gateway.Id}", s.Config.CacheFor, () => s.Source.ListAsync(gateway, CancellationToken.None)))); }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { problems.Add($"{gateway.Label}: {e.Message.ReplaceLineEndings(" ")}"); }
        }
        return new ApiCatalogueList(time.GetUtcNow(), true, Summaries(s.Config, s.Gateways, perGateway, s.Matcher, s.View), problems);
    }

    private static IReadOnlyList<ApiSummary> Summaries(ApiCatalogueConfig config, IReadOnlyList<GatewayRef> all, List<(GatewayRef Gateway, IReadOnlyList<SourceApi> Apis)> read,
        ApiMatcher matcher, TownRegistry view)
    {
        var groupOf = view.AllNodes.ToDictionary(n => n.Id, n => n.GroupId, StringComparer.OrdinalIgnoreCase);
        var entries = new List<(string Id, string Name, SourceApi First, List<GatewayRef> On)>();
        foreach (var (gateway, apis) in read)
            foreach (var api in apis)
            {
                var id = EntryId(config, gateway, api);
                if (entries.FindIndex(e => e.Id.Equals(id, StringComparison.OrdinalIgnoreCase)) is var i and >= 0) entries[i].On.Add(gateway);
                else entries.Add((id, api.Name, api, [gateway]));
            }
        var readLabels = read.Select(r => r.Gateway.Label).ToList();
        return entries.Select(e =>
        {
            var backend = e.First.BackendUrl;
            var match = matcher.Match(backend);
            var host = Uri.TryCreate(backend, UriKind.Absolute, out var uri) ? uri.Host : null;
            // a copy missing from a gateway that was read shows; a gateway that could not be read says nothing about it
            var missing = config.Merge ? readLabels.Where(l => !e.On.Any(g => g.Label == l)).ToList() : [];
            return new ApiSummary(e.Id, e.Name, e.First.DisplayName, e.First.Path, backend, host, e.On.Select(g => g.Label).ToList(), missing, match.SystemId,
                match.SystemId is { } sys && groupOf.TryGetValue(sys, out var group) ? group : null, match.ThirdPartyId);
        }).OrderBy(a => a.DisplayName, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>The id an API goes by: its name when the gateways are copies, the gateway's label and the name when they are not.</summary>
    private static string EntryId(ApiCatalogueConfig config, GatewayRef gateway, SourceApi api) => config.Merge ? api.Name : $"{gateway.Label}:{api.Name}";

    /// <summary>One API with its operations and the policy on it, from the gateways that serve it, and what differs between them. Null when the id is unknown.</summary>
    public async Task<ApiDetail?> DetailAsync(string id, CancellationToken ct)
    {
        if (Start() is not { } s) return null;
        var list = await ListAsync(ct);
        if (list.Apis.FirstOrDefault(a => a.Id.Equals(id, StringComparison.OrdinalIgnoreCase)) is not { } summary) return null;
        var served = await ServingAsync(s.Config, s.Gateways, s.Source, summary, ct);
        var details = new List<(GatewayRef Gateway, SourceApiDetail Detail)>();
        foreach (var (gateway, apiId) in served)
            details.Add((gateway, await Cached($"detail|{s.Source.Name}|{gateway.Id}|{apiId}", s.Config.CacheFor, () => s.Source.DetailAsync(gateway, apiId, CancellationToken.None))));
        if (details.Count == 0) return new ApiDetail(summary, [], new ApiPolicyInfo(null, []), []);
        var primary = details.OrderByDescending(d => d.Detail.Operations.Count).First();
        var policy = primary.Detail.Policy is { } p ? Mask(p) : null;
        return new ApiDetail(summary, primary.Detail.Operations.OrderBy(o => o.UrlTemplate, StringComparer.OrdinalIgnoreCase).ThenBy(o => o.Method, StringComparer.Ordinal).ToList(),
            policy ?? new ApiPolicyInfo(null, []), Differences(summary, details));
    }

    /// <summary>The policy on one operation of an API (null Xml when none is set on it), taken from the first gateway that serves the API.</summary>
    public async Task<ApiPolicyInfo?> OperationPolicyAsync(string id, string operationId, CancellationToken ct)
    {
        if (Start() is not { } s) return null;
        var list = await ListAsync(ct);
        if (list.Apis.FirstOrDefault(a => a.Id.Equals(id, StringComparison.OrdinalIgnoreCase)) is not { } summary) return null;
        var served = await ServingAsync(s.Config, s.Gateways, s.Source, summary, ct);
        if (served.Count == 0) return null;
        var (gateway, apiId) = served[0];
        var policy = await Cached($"op|{s.Source.Name}|{gateway.Id}|{apiId}|{operationId}", s.Config.CacheFor, async () => (object?)await s.Source.OperationPolicyAsync(gateway, apiId, operationId, CancellationToken.None) ?? NoPolicy);
        return policy is SourcePolicy found ? Mask(found) : new ApiPolicyInfo(null, []);
    }

    private static readonly object NoPolicy = new();

    /// <summary>The gateways that serve an API and the id the gateway knows it by (read again from the cached lists).</summary>
    private async Task<List<(GatewayRef Gateway, string ApiId)>> ServingAsync(ApiCatalogueConfig config, IReadOnlyList<GatewayRef> gateways, IApiCatalogueSource source, ApiSummary summary, CancellationToken ct)
    {
        var served = new List<(GatewayRef, string)>();
        foreach (var gateway in gateways.Where(g => summary.Gateways.Contains(g.Label)))
        {
            var apis = await Cached($"list|{source.Name}|{gateway.Id}", config.CacheFor, () => source.ListAsync(gateway, CancellationToken.None));
            if (apis.FirstOrDefault(a => EntryId(config, gateway, a).Equals(summary.Id, StringComparison.OrdinalIgnoreCase)) is { } api) served.Add((gateway, api.Id));
        }
        return served;
    }

    private static ApiPolicyInfo Mask(SourcePolicy p) =>
        new(PolicyMask.Apply(p.Xml), p.Fragments.Select(f => new ApiFragmentInfo(f.Id, f.Xml is null ? null : PolicyMask.Apply(f.Xml))).ToList());

    /// <summary>What is not the same on the gateways that serve an API: operations only one has, a policy that differs, an API missing from a gateway.</summary>
    public static IReadOnlyList<string> Differences(ApiSummary summary, IReadOnlyList<(GatewayRef Gateway, SourceApiDetail Detail)> details)
    {
        var notes = new List<string>();
        if (summary.MissingFrom.Count > 0) notes.Add($"Not on {string.Join(" or ", summary.MissingFrom)}.");
        if (details.Count < 2) return notes;
        string Key(ApiOperationInfo o) => $"{o.Method.ToUpperInvariant()} {o.UrlTemplate}";
        var union = details.SelectMany(d => d.Detail.Operations.Select(Key)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var (gateway, detail) in details)
        {
            var own = detail.Operations.Select(Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var lacking = union.Where(k => !own.Contains(k)).Order(StringComparer.OrdinalIgnoreCase).ToList();
            if (lacking.Count > 0) notes.Add($"{gateway.Label} lacks {lacking.Count} operation{(lacking.Count == 1 ? "" : "s")}: {string.Join(", ", lacking.Take(5))}{(lacking.Count > 5 ? ", ..." : "")}.");
        }
        var policies = details.Select(d => (d.Gateway.Label, Text: Normal(d.Detail.Policy?.Xml))).ToList();
        if (policies.Select(p => p.Text).Distinct(StringComparer.Ordinal).Count() > 1)
            notes.Add($"The policy differs between {string.Join(" and ", policies.Select(p => p.Label))}.");
        return notes;
    }

    private static string Normal(string? xml) => xml is null ? "" : string.Join(' ', xml.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}
