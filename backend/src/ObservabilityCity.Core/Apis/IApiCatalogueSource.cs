using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Apis;

/// <summary>One gateway to read APIs from: the cloud's id for it, its name and the short label the explorer shows for it (its region when the scope rules know one).</summary>
public sealed record GatewayRef(string Id, string Name, string Label);

/// <summary>One API of a gateway as the list gives it. Id is what the source needs to ask about it again; Name is the one a merge across gateways joins on.</summary>
public sealed record SourceApi(string Id, string Name, string DisplayName, string? Path, string? BackendUrl);

/// <summary>What one API holds: its operations, and the policy set directly on it (null: none set).</summary>
public sealed record SourceApiDetail(IReadOnlyList<ApiOperationInfo> Operations, SourcePolicy? Policy, IReadOnlyList<string>? Notes = null);

/// <summary>A policy as the gateway holds it: its XML and the fragments it includes. The source has already cleaned the text up (no byte-order mark); masking is the catalogue's job.</summary>
public sealed record SourcePolicy(string Xml, IReadOnlyList<ApiFragmentInfo> Fragments);

/// <summary>
/// Where the API explorer reads its APIs from: a source of a kind that declares <see cref="Sources.SourceCapabilities.ApiCatalogue"/> (on Azure, an API Management service). Asked on demand when the
/// explorer opens and cached by the catalogue, never polled and never part of health. The core knows no cloud: a gateway is an id, an API a name, and everything else comes from here.
/// </summary>
public interface IApiCatalogueSource
{
    string Name { get; }

    /// <summary>The current APIs of one gateway.</summary>
    Task<IReadOnlyList<SourceApi>> ListAsync(GatewayRef gateway, CancellationToken ct);

    /// <summary>The operations of one API and the policy set on it. A gateway that has no policy on it gives a null policy, not an error.</summary>
    Task<SourceApiDetail> DetailAsync(GatewayRef gateway, string apiId, CancellationToken ct);

    /// <summary>The policy set directly on one operation; null when none is set.</summary>
    Task<SourcePolicy?> OperationPolicyAsync(GatewayRef gateway, string apiId, string operationId, CancellationToken ct);
}
