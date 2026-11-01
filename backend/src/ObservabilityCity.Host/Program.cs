using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Links;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Host;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);

// A town whose files every other file depends on being sound stops the server, as before; an extra town that is broken is left out and reported.
var townFolders = RegistryPath.ResolveAll(builder.Configuration);
var loaded = new List<(string Folder, Registry Registry)>();
foreach (var folder in townFolders)
{
    try { loaded.Add((folder, RegistryLoader.LoadResilient(folder))); }
    catch (Exception e) when (loaded.Count > 0)
    {
        Console.Error.WriteLine($"Town {folder} left out: {e.Message.ReplaceLineEndings(" ")}");
    }
}
foreach (var (_, registry) in loaded)
    foreach (var notice in registry.Notices) Console.Error.WriteLine($"Registry notice ({registry.Town.Id}): {notice}");

// `dotnet run --project src/ObservabilityCity.Host -- --write-schema` refreshes the registry's editor schemas and exits.
if (args.Contains("--write-schema"))
{
    foreach (var (folder, registry) in loaded)
    {
        RegistrySchema.Write(registry, folder);
        Console.WriteLine($"Schemas written to {Path.Combine(folder, RegistrySchema.FolderName)}");
    }
    return;
}

var fakeOptions = builder.Configuration.GetSection("Fake").Get<FakeOptions>() ?? new FakeOptions();
var snapshotInterval = TimeSpan.FromSeconds(builder.Configuration.GetValue("Snapshot:IntervalSeconds", 2.0));
var staleAfter = TimeSpan.FromSeconds(builder.Configuration.GetValue("Snapshot:StaleAfterSeconds", 30.0));

// The adapters this build has: every module found in adapters/ beside the program (Adapters:Path moves the folder). A live environment starts
// one source for each source its file defines. The host knows no platform by name; no module for it means its kinds are unknown.
var adapterFolder = builder.Configuration["Adapters:Path"] ?? Path.Combine(AppContext.BaseDirectory, "adapters");
var plugins = AdapterLoader.LoadFrom(adapterFolder);
foreach (var problem in plugins.Problems) Console.Error.WriteLine(problem);
var sourceCatalog = new AdapterCatalog(plugins.Modules);
Console.WriteLine($"Adapters: {string.Join(", ", sourceCatalog.Modules)}");
foreach (var (_, registry) in loaded)
    foreach (var environment in registry.Environments)
        foreach (var problem in sourceCatalog.Check(environment)) Console.Error.WriteLine(problem);

// One runtime for each environment of each town (a town without environments has the one, "demo"): its own source, readings and snapshots.
var townRuntimes = new List<TownRuntime>();
var hostedByTown = new List<(TownRuntime Town, List<EnvironmentRuntime> Runtimes)>();
foreach (var (folder, registry) in loaded)
{
    if (townRuntimes.Any(t => t.Id == registry.Town.Id))
    {
        Console.Error.WriteLine($"Town {folder} left out: another town already has the id '{registry.Town.Id}'.");
        continue;
    }
    var registries = new RegistryHolder(registry);
    // A demo town runs on the fake source and can be steered (Break things, stories). A live town has no fake source at all and no /api/fake.
    // The mode is read once, when the server starts: change town.yaml and restart to switch.
    var demo = registry.Town.IsDemo;
    var mode = registry.Town.Mode;
    var fakeProfiles = demo ? FakeProfiles.Load(folder) : new Dictionary<string, FakeProfile>();
    var (stories, storyNotices) = demo ? StoryFiles.Load(folder) : ([], []);
    foreach (var notice in storyNotices) Console.Error.WriteLine($"Registry notice ({registry.Town.Id}): {notice}");
    var environmentIds = registry.Environments.Count > 0 ? registry.Environments.Select(e => e.Id).ToList() : [Registry.DemoEnvironmentId];
    var runtimes = new List<EnvironmentRuntime>();
    foreach (var environmentId in environmentIds)
    {
        // link discovery saves under the town's folder, one folder for each environment; a town without a links block has none
        var discovered = registry.Environments.FirstOrDefault(e => e.Id == environmentId)?.Links is not null
            ? new DiscoveredLinks(Path.Combine(folder, RegistryReloader.DiscoveredFolder, "links", environmentId)) : null;
        var view = new EnvironmentRegistry(registries, environmentId, discovered);
        var fake = demo ? new FakeSource(fakeProfiles, fakeOptions, TimeProvider.System, stories) : null;
        // a live environment polls what its file defines; a demo town has the fake source and nothing else
        var set = fake is not null || registry.Environments.FirstOrDefault(e => e.Id == environmentId) is not { } environment
            ? new SourceSet(fake is null ? [] : [fake], [])
            : sourceCatalog.Build(environment, folder);
        foreach (var problem in set.Problems) Console.Error.WriteLine($"Source notice ({registry.Town.Id}): {problem}");
        var state = new LatestState();
        // a live town carries on from the last readings after a restart (the town's freshness rule still decides whether they count); a demo town has none
        var readings = fake is null ? new ReadingCache(Path.Combine(folder, RegistryReloader.DiscoveredFolder, "readings", environmentId)) : null;
        if (readings is not null)
            foreach (var source in set.Sources) state.Update(source.Name, readings.Load(source.Name));
        var store = new SnapshotStore();
        var snapshots = new SnapshotBuilder(view, state, TimeProvider.System)
        {
            IncidentSources = fake is null ? [] : [fake],
            Environment = environmentId,
            Traffic = discovered?.Traffic,
            ScopeSource = set.Scope,
            FixedAssets = demo ? FakeAssets.Load(folder) : null,
            Mode = mode,
            StaleAfter = staleAfter,
            SourceIntervals = set.Sources.GroupBy(s => s.Name).ToDictionary(g => g.Key, g => g.First().PollInterval),
            // a demo town has its own sped-up day; a live one shows the real time of day
            DayFraction = fake is null ? () => TimeProvider.System.GetLocalNow().TimeOfDay.TotalDays : () => fake.DayFraction,
        };
        ILogSource logs = fake is null ? new NoLogSource() : new FakeLogSource(state, TimeProvider.System, staleAfter);
        runtimes.Add(new EnvironmentRuntime(registry.Town.Id, environmentId, view, fake, state, snapshots, store, logs, set.Sources, set.Problems, set.Scope, discovered, readings));
    }
    var town = new TownRuntime(registry.Town.Id, registry.Town.Name, folder, registries, new EnvironmentSet(runtimes, registry.DefaultEnvironmentId, registry.Town.Id));
    townRuntimes.Add(town);
    hostedByTown.Add((town, runtimes));
}
var defaultTown = builder.Configuration["Registry:DefaultTown"] is { Length: > 0 } wanted && townRuntimes.Any(t => t.Id == wanted) ? wanted : townRuntimes[0].Id;
var towns = new TownSet(townRuntimes, defaultTown);

builder.Services.AddSingleton(towns);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IslandViews>();
foreach (var (town, runtimes) in hostedByTown)
{
    var holder = town.Registry;
    builder.Services.AddSingleton<IHostedService>(sp => new RegistryReloader(
        holder, town.Folder, TimeSpan.FromSeconds(builder.Configuration.GetValue("Registry:WatchSeconds", 5.0)), sp.GetRequiredService<ILogger<RegistryReloader>>()));
    foreach (var rt in runtimes)
    {
        // AddHostedService would keep only the first of each type, so these are added as plain services
        builder.Services.AddSingleton<IHostedService>(sp => new SourcePoller(rt.Sources, rt.Registry, rt.State, sp.GetRequiredService<ILogger<SourcePoller>>(), rt.Readings));
        if (rt.Discovered is not null && rt.Sources.OfType<IDependencySource>().FirstOrDefault(s => s.CanReadDependencies && ((IMetricSource)s).Name == rt.Registry.Current.ActiveEnvironment?.Links?.Source) is { } dependencies)
            builder.Services.AddSingleton<IHostedService>(sp => new LinkDiscoveryRunner(dependencies, rt.Scope, rt.Registry, rt.Discovered, TimeProvider.System, sp.GetRequiredService<ILogger<LinkDiscoveryRunner>>()));
        if (rt.Discovered is not null && rt.Registry.Current.ActiveEnvironment?.Links?.Traffic is not null
            && rt.Sources.OfType<IDependencySource>().FirstOrDefault(s => s.CanReadDependencies && ((IMetricSource)s).Name == rt.Registry.Current.ActiveEnvironment.Links.Source) is { } trafficSource)
            builder.Services.AddSingleton<IHostedService>(sp => new LinkTrafficRunner(trafficSource, rt.Scope, rt.Registry, rt.Discovered.Traffic, TimeProvider.System, sp.GetRequiredService<ILogger<LinkTrafficRunner>>(), trafficSource as IRateHistory));
        builder.Services.AddSingleton<IHostedService>(sp => new SnapshotPublisher(rt.Builder, rt.Store,
            new SignalRSnapshotNotifier(sp.GetRequiredService<IHubContext<TownHub>>(), town.Environments, sp.GetRequiredService<IslandViews>()),
            snapshotInterval, sp.GetRequiredService<ILogger<SnapshotPublisher>>()));
    }
}
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
builder.Services.AddSignalR();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SupportNonNullableReferenceTypes();
    c.SchemaFilter<RequireAllPropertiesFilter>();
});

var app = builder.Build();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", town = towns.Default.Registry.Current.Town.Name }))
   .ExcludeFromDescription();

// The towns the server runs. Which one an endpoint answers for is the ?town= of its address, and which environment of it the ?env=; without them, the defaults.
app.MapGet("/api/towns", (TownSet all) => all.Infos)
   .Produces<TownSummary[]>()
   .WithName("GetTowns");

app.MapGet("/api/environments", (EnvironmentSet envs) =>
        !envs.Exists ? EnvironmentNotFound(envs, null) : Results.Ok(envs.All.Select(e => new EnvironmentInfo(e.Id, e.Registry.Current.ActiveEnvironment?.Name ?? e.Id, e.Id == envs.Default.Id))))
   .Produces<EnvironmentInfo[]>()
   .WithName("GetEnvironments");

// ?islands=a,b shows only those islands (and the hub); totals, third parties and traffic then count only what is on screen.
app.MapGet("/api/snapshot/latest", (EnvironmentSet envs, string? env, string? islands) =>
        envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env)
        : rt.Store.Latest is not { } s ? Results.StatusCode(StatusCodes.Status503ServiceUnavailable)
        : IslandViews.Parse(islands is null ? null : [islands]) is { Count: > 0 } filter ? Results.Ok(rt.Builder.Build(filter))
        : Results.Ok(s))
   .Produces<Snapshot>()
   .WithName("GetLatestSnapshot");

// What the inspector shows beyond the live numbers: links, and the settings in force with the layer each came from.
app.MapGet("/api/systems/{id}", (string id, EnvironmentSet envs, string? env) =>
        envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env)
        : SystemDetails.Of(rt.Registry.Current, id) is { } detail ? Results.Ok(detail with { Scope = ScopeInfos.Of(rt.Registry.Current, rt.Scope, id) })
        : Results.NotFound(new { error = $"No system '{id}'." }))
   .Produces<SystemDetail>()
   .WithName("GetSystem");

// Recent log lines of one system, newest first. Read on demand while its inspector is open.
app.MapGet("/api/systems/{id}/logs", async (string id, EnvironmentSet envs, string? env, int? limit, CancellationToken ct) =>
    {
        if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
        var registry = rt.Registry.Current;
        var node = registry.AllNodes.FirstOrDefault(n => n.Id == id) ?? registry.Vendors.FirstOrDefault(v => v.Node.Id == id)?.Node;
        return node is null ? Results.NotFound(new { error = $"No system '{id}'." }) : Results.Ok(await rt.Logs.RecentAsync(node, limit ?? 60, ct));
    })
   .Produces<LogLine[]>()
   .WithName("GetSystemLogs");

// Demo steering for the fake generator: the Break things panel and the story bar are built on this.
// With several towns, only a demo town answers: asking a live town for a fake call is a plain 404.
if (townRuntimes.Any(t => t.Environments.Default.Fake is not null))
{
var fx = app.MapGroup("/api/fake").ExcludeFromDescription();
fx.AddEndpointFilter(async (ctx, next) =>
{
    var envs = ctx.Arguments.OfType<EnvironmentSet>().FirstOrDefault();
    var env = ctx.HttpContext.Request.Query["env"].ToString();
    return envs is { Exists: true } && envs.Find(env) is { Fake: null }
        ? Results.NotFound(new { error = "This town runs on live readings: there is nothing to steer." })
        : await next(ctx);
});
fx.MapGet("/", (EnvironmentSet envs, string? env) =>
    envs.Find(env) is { } rt
        ? Results.Ok(new { calm = rt.Fake!.Calm, dayLengthSeconds = rt.Fake!.DayLengthSeconds, effects = rt.Fake!.Effects, story = rt.Fake!.Story.State() })
        : EnvironmentNotFound(envs, env));
fx.MapPost("/effects", (EffectRequest r, EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    if (r.Target is null) return Results.BadRequest("target is required");
    try { return Results.Ok(rt.Fake!.Add(r.Target, r.Kind, r.Intensity)); }
    catch (ArgumentException e) { return Results.BadRequest(e.Message); }
});
fx.MapPut("/effects/{id}", (string id, IntensityRequest r, EnvironmentSet envs, string? env) =>
    envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env) : rt.Fake!.SetIntensity(id, r.Intensity) ? Results.NoContent() : Results.NotFound());
fx.MapDelete("/effects/{id}", (string id, EnvironmentSet envs, string? env) =>
    envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env) : rt.Fake!.Remove(id) ? Results.NoContent() : Results.NotFound());
fx.MapDelete("/effects", (EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    rt.Fake!.Clear();
    return Results.NoContent();
});
fx.MapPost("/reset", (EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    rt.Fake!.Reset();
    return Results.NoContent();
});
fx.MapPost("/calm", (CalmRequest r, EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    rt.Fake!.Calm = r.On;
    return Results.Ok(new { calm = rt.Fake!.Calm });
});

fx.MapPost("/day", (DayRequest r, EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    if (!(r.Seconds >= 5)) return Results.BadRequest("a day takes at least 5 seconds");
    rt.Fake!.DayLengthSeconds = r.Seconds;
    return Results.Ok(new { dayLengthSeconds = rt.Fake!.DayLengthSeconds });
});

// Stories: timelines of the same effects. One plays at a time; its effects go away when it stops or the panel is reset.
fx.MapGet("/stories", (EnvironmentSet envs, string? env) =>
    envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env)
    : Results.Ok(rt.Fake!.Story.Library.Select(s => new StorySummary(
        s.Id, s.Name, s.Description, s.Duration,
        s.Steps.Select((st, i) => new StoryStepSummary(i, st.At, st.Caption, st.Camera)).ToList()))));
fx.MapGet("/story", (EnvironmentSet envs, string? env) =>
    envs.Find(env) is { } rt ? Results.Ok(rt.Fake!.Story.State()) : EnvironmentNotFound(envs, env));
fx.MapPost("/story/play", (PlayRequest r, EnvironmentSet envs, string? env) =>
    envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env)
    : r.Id is not null && rt.Fake!.Story.Play(r.Id, r.Speed) ? Results.Ok(rt.Fake!.Story.State())
    : Results.NotFound(new { error = $"No story '{r.Id}'.", stories = envs.Default.Fake!.Story.Library.Select(s => s.Id) }));
fx.MapPost("/story/pause", (EnvironmentSet envs, string? env) => StoryAction(envs, env, p => p.Pause()));
fx.MapPost("/story/resume", (EnvironmentSet envs, string? env) => StoryAction(envs, env, p => p.Resume()));
fx.MapPost("/story/stop", (EnvironmentSet envs, string? env) => StoryAction(envs, env, p => p.Stop()));
fx.MapPost("/story/seek", (SeekRequest r, EnvironmentSet envs, string? env) => StoryAction(envs, env, p => p.Seek(r.Seconds)));
fx.MapPost("/story/speed", (SpeedRequest r, EnvironmentSet envs, string? env) => StoryAction(envs, env, p => p.SetSpeed(r.Speed)));

static IResult StoryAction(EnvironmentSet envs, string? env, Action<StoryPlayer> act)
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    act(rt.Fake!.Story);
    return Results.Ok(rt.Fake!.Story.State());
}
}

static IResult EnvironmentNotFound(EnvironmentSet envs, string? env) =>
    envs.Exists
        ? Results.NotFound(new { error = $"No environment '{env}'.", environments = envs.All.Select(e => e.Id) })
        : Results.NotFound(new { error = $"No town '{envs.TownId}'.", towns = Array.Empty<string>() });

app.MapHub<TownHub>("/hubs/town");

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
}

app.Run();

record EffectRequest(string? Target, FakeEffectKind Kind, double Intensity);
record CalmRequest(bool On);
record IntensityRequest(double Intensity);
record DayRequest(double Seconds);
record PlayRequest(string? Id, double? Speed);
record SeekRequest(double Seconds);
record SpeedRequest(double Speed);
record StorySummary(string Id, string Name, string? Description, double Duration, IReadOnlyList<StoryStepSummary> Steps);
record StoryStepSummary(int Index, double At, string? Caption, string? Camera);

// Lets tests use WebApplicationFactory<Program>.
public partial class Program;
