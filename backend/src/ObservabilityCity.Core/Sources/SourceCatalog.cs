using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Sources;

/// <summary>Gives a bearer token for a scope. An Azure source asks for one when it needs to; nothing signs in before then.</summary>
public interface ICredentialSource
{
    Task<string> GetTokenAsync(string scope, CancellationToken ct);
}

/// <summary>What an adapter needs to start: the source as the environment defines it and, for an Azure source, the login it is to use.</summary>
public sealed record SourceContext(string EnvironmentId, RegistrySource Source, ICredentialSource? Credential);

/// <summary>Makes the source of one kind. Adapters register one each; the core knows none of them by name.</summary>
public interface IMetricSourceFactory
{
    string Kind { get; }
    IMetricSource Create(SourceContext context);
}

/// <summary>Reads how a login is made from the registry and turns it into one that can give a token. The Azure adapter project supplies it.</summary>
public interface ICredentialFactory
{
    ICredentialSource Create(RegistryCredential credential);
}

/// <summary>The sources an environment runs and what was wrong with the ones it could not.</summary>
public sealed record SourceSet(IReadOnlyList<IMetricSource> Sources, IReadOnlyList<string> Problems);

/// <summary>
/// Turns an environment's source definitions into running sources, through the adapters that are registered for their kinds. A source whose kind has
/// no adapter yet, or whose login cannot be made, is left out and reported: its signals then have no fresh data, which is not the same as having no
/// source (that is the signal being absent).
/// </summary>
public sealed class SourceCatalog(IEnumerable<IMetricSourceFactory> factories, ICredentialFactory? credentials = null)
{
    private readonly Dictionary<string, IMetricSourceFactory> _factories = factories.ToDictionary(f => f.Kind, StringComparer.Ordinal);

    public SourceSet Build(RegistryEnvironment environment)
    {
        var sources = new List<IMetricSource>();
        var problems = new List<string>();
        var logins = new Dictionary<string, ICredentialSource>();
        foreach (var def in environment.Sources)
        {
            if (def.Kind == SourceKinds.Fake)
            {
                problems.Add($"Environment '{environment.Id}': source '{def.Name}' is fake, which only a demo town runs.");
                continue;
            }
            if (def.Name == "incidents") continue; // incident adapters are not metric sources
            if (!_factories.TryGetValue(def.Kind, out var factory))
            {
                problems.Add($"Environment '{environment.Id}': source '{def.Name}' is a {def.Kind} source, and this build has no adapter for {def.Kind} yet, so its signals have no data.");
                continue;
            }
            try
            {
                sources.Add(factory.Create(new SourceContext(environment.Id, def, Login(environment, def, logins))));
            }
            catch (Exception e) when (e is InvalidOperationException or ArgumentException)
            {
                problems.Add($"Environment '{environment.Id}': source '{def.Name}' could not start: {e.Message}");
            }
        }
        return new SourceSet(sources, problems);
    }

    /// <summary>The login an Azure source signs in with: the one it names, else the Azure CLI login. One login is shared by the sources that name it.</summary>
    private ICredentialSource? Login(RegistryEnvironment environment, RegistrySource def, Dictionary<string, ICredentialSource> made)
    {
        if (!SourceKinds.UsesAzureLogin(def.Kind)) return null;
        if (credentials is null) throw new InvalidOperationException($"this build cannot sign in to Azure");
        var name = def.Credential ?? CredentialKinds.ImplicitName;
        if (made.TryGetValue(name, out var existing)) return existing;
        var spec = environment.Credentials.FirstOrDefault(c => c.Name == name)
            ?? new RegistryCredential(CredentialKinds.ImplicitName, CredentialKinds.AzureCli, null, null, null);
        return made[name] = credentials.Create(spec);
    }
}
