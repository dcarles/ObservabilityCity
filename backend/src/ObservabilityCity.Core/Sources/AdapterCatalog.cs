using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;

namespace ObservabilityCity.Core.Sources;

/// <summary>Gives a bearer token for a scope. A source asks for one when it needs to; nothing signs in before then.</summary>
public interface ICredentialSource
{
    Task<string> GetTokenAsync(string scope, CancellationToken ct);
}

/// <summary>
/// What an adapter needs to start: the source as the environment defines it and, for a source that signs in, the login it is to use. <see cref="Rules"/>
/// are the environment's scope rules and <see cref="Scope"/> the place an inventory source leaves what it reads (and other adapters look it up).
/// <see cref="RegistryFolder"/> is where the town's files are, for a source that reads a file named relative to them.
/// </summary>
public sealed record SourceContext(string EnvironmentId, RegistrySource Source, ICredentialSource? Credential, ScopeRules? Rules = null, ScopeStore? Scope = null, string? RegistryFolder = null);

/// <summary>Makes the source of one kind. Adapters register one each; the core knows none of them by name.</summary>
public interface IMetricSourceFactory
{
    string Kind { get; }
    IMetricSource Create(SourceContext context);
}

/// <summary>
/// One way to sign in, named by the <c>kind</c> of a <c>credentials:</c> entry. It says what is wrong with an entry of its kind (so a mistake shows
/// before the town runs) and makes the login. Making a login signs nobody in.
/// </summary>
public interface ICredentialKind
{
    string Kind { get; }
    /// <summary>Problems with this entry, in words; empty when it is fine.</summary>
    IEnumerable<string> Check(RegistryCredential credential);
    /// <summary>Throws <see cref="InvalidOperationException"/> when the entry cannot be made into a login (a secret variable that is not set).</summary>
    ICredentialSource Create(RegistryCredential credential);
}

/// <summary>
/// A kind of source that exists, whether or not an adapter for it does yet. <paramref name="DefaultCredentialKind"/> is the login a source of this
/// kind uses when it names none; null means it does not sign in.
/// </summary>
public sealed record SourceKindInfo(string Kind, string? DefaultCredentialKind = null);

/// <summary>What an adapter module adds to the town.</summary>
public interface IAdapterRegistry
{
    void AddSourceKind(SourceKindInfo kind);
    void AddSource(IMetricSourceFactory factory);
    void AddCredentialKind(ICredentialKind kind);
}

/// <summary>
/// A bundle of adapters for one platform (a cloud, a metrics system). The host loads every module it finds and lets each one register what it has;
/// the core never mentions a platform. A fork adds a module for its own platform and leaves out the ones it does not use.
/// </summary>
public interface IAdapterModule
{
    string Name { get; }
    void Register(IAdapterRegistry registry);
}

/// <summary>The sources an environment runs and what was wrong with the ones it could not.</summary>
public sealed record SourceSet(IReadOnlyList<IMetricSource> Sources, IReadOnlyList<string> Problems, ScopeStore? Scope = null);

/// <summary>The source kinds the core itself has no login for: the fake source, and kinds read over plain HTTP.</summary>
public sealed class CoreAdapters : IAdapterModule
{
    public string Name => "core";

    public void Register(IAdapterRegistry registry)
    {
        foreach (var kind in new[] { SourceKinds.Fake, "prometheus", "grafana-irm" }) registry.AddSourceKind(new SourceKindInfo(kind));
    }
}

/// <summary>
/// Everything the loaded adapter modules registered. It checks an environment against it (a source kind or login kind no module knows is a mistake
/// worth naming) and turns an environment's source definitions into running sources. A source whose kind has no adapter yet, or whose login cannot
/// be made, is left out and reported: its signals then have no fresh data, which is not the same as having no source (that is the signal being absent).
/// </summary>
public sealed class AdapterCatalog : IAdapterRegistry
{
    private readonly Dictionary<string, SourceKindInfo> _kinds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IMetricSourceFactory> _factories = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ICredentialKind> _logins = new(StringComparer.Ordinal);
    private readonly List<string> _modules = [];

    public AdapterCatalog(IEnumerable<IAdapterModule> modules)
    {
        foreach (var module in new IAdapterModule[] { new CoreAdapters() }.Concat(modules))
        {
            _modules.Add(module.Name);
            module.Register(this);
        }
    }

    public IReadOnlyList<string> Modules => _modules;
    public IReadOnlyCollection<string> SourceKindNames => _kinds.Keys;
    public IReadOnlyCollection<string> CredentialKindNames => _logins.Keys;

    public void AddSourceKind(SourceKindInfo kind) => _kinds[kind.Kind] = kind;

    public void AddSource(IMetricSourceFactory factory)
    {
        _factories[factory.Kind] = factory;
        _kinds.TryAdd(factory.Kind, new SourceKindInfo(factory.Kind));
    }

    public void AddCredentialKind(ICredentialKind kind) => _logins[kind.Kind] = kind;

    /// <summary>What is wrong with an environment's sources and logins, as the environment file would be told it. Empty when all is well.</summary>
    public IReadOnlyList<string> Check(RegistryEnvironment environment)
    {
        var name = $"environments/{environment.Id}.yaml";
        var problems = new List<string>();
        var kinds = _kinds.Keys.ToList();
        foreach (var source in environment.Sources)
        {
            if (!_kinds.TryGetValue(source.Kind, out var info))
            {
                problems.Add($"{name}: source '{source.Name}' has kind '{source.Kind}', which is not a kind of source this build knows. Use {string.Join(", ", kinds)}.{DidYouMean.Hint(source.Kind, kinds)}");
                continue;
            }
            if (source.Credential is not null && info.DefaultCredentialKind is null)
                problems.Add($"{name}: source '{source.Name}' names a credential, but a {source.Kind} source does not sign in");
        }
        foreach (var credential in environment.Credentials)
        {
            if (!_logins.TryGetValue(credential.Kind, out var kind))
            {
                var known = _logins.Keys.ToList();
                problems.Add($"{name}: credential '{credential.Name}' has kind '{credential.Kind}'. Use {string.Join(", ", known)}.{DidYouMean.Hint(credential.Kind, known)}");
                continue;
            }
            foreach (var problem in kind.Check(credential)) problems.Add($"{name}: {problem}");
        }
        return problems;
    }

    public SourceSet Build(RegistryEnvironment environment, string? registryFolder = null)
    {
        var scope = new ScopeStore();
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
                problems.Add($"Environment '{environment.Id}': source '{def.Name}' is a {def.Kind} source, and no loaded adapter reads {def.Kind} yet, so its signals have no data.");
                continue;
            }
            try
            {
                sources.Add(factory.Create(new SourceContext(environment.Id, def, Login(environment, def, logins), environment.Scope, scope, registryFolder)));
            }
            catch (Exception e) when (e is InvalidOperationException or ArgumentException)
            {
                problems.Add($"Environment '{environment.Id}': source '{def.Name}' could not start: {e.Message}");
            }
        }
        return new SourceSet(sources, problems, scope);
    }

    /// <summary>The login a source signs in with: the one it names, else the environment's login called default, else its kind's usual one. One login is shared by the sources that name it.</summary>
    private ICredentialSource? Login(RegistryEnvironment environment, RegistrySource def, Dictionary<string, ICredentialSource> made)
    {
        var usual = _kinds.GetValueOrDefault(def.Kind)?.DefaultCredentialKind;
        if (usual is null) return null;
        var name = def.Credential ?? "default";
        if (made.TryGetValue(name, out var existing)) return existing;
        var spec = environment.Credentials.FirstOrDefault(c => c.Name == name) ?? new RegistryCredential("default", usual, null, null, null);
        if (!_logins.TryGetValue(spec.Kind, out var kind)) throw new InvalidOperationException($"no loaded adapter signs in with '{spec.Kind}'");
        return made[name] = kind.Create(spec);
    }
}
