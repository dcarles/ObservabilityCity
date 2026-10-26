using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Host;

var builder = WebApplication.CreateBuilder(args);

var registryPath = RegistryPath.Resolve(builder.Configuration);
// A pillar file with problems is skipped (its island shows a config error). The files every pillar depends on must be sound.
var registry = RegistryLoader.LoadResilient(registryPath);
foreach (var notice in registry.Notices) Console.Error.WriteLine($"Registry notice: {notice}");
var registries = new RegistryHolder(registry);

// `dotnet run --project src/ObservabilityCity.Host -- --write-schema` refreshes the registry's editor schemas and exits.
if (args.Contains("--write-schema"))
{
    RegistrySchema.Write(registry, registryPath);
    Console.WriteLine($"Schemas written to {Path.Combine(registryPath, RegistrySchema.FolderName)}");
    return;
}

var fakeOptions = builder.Configuration.GetSection("Fake").Get<FakeOptions>() ?? new FakeOptions();
var fakeProfiles = FakeProfiles.Load(registryPath);
var snapshotInterval = TimeSpan.FromSeconds(builder.Configuration.GetValue("Snapshot:IntervalSeconds", 2.0));
var staleAfter = TimeSpan.FromSeconds(builder.Configuration.GetValue("Snapshot:StaleAfterSeconds", 30.0));

// One runtime for each environment of the town (a town without environments has the one, "demo"): its own source, readings and snapshots.
var environmentIds = registry.Environments.Count > 0 ? registry.Environments.Select(e => e.Id).ToList() : [Registry.DemoEnvironmentId];
var runtimes = new List<EnvironmentRuntime>();
foreach (var environmentId in environmentIds)
{
    var view = new EnvironmentRegistry(registries, environmentId);
    var fake = new FakeSource(fakeProfiles, fakeOptions, TimeProvider.System);
    var state = new LatestState();
    var store = new SnapshotStore();
    var snapshots = new SnapshotBuilder(view, state, TimeProvider.System)
    {
        IncidentSources = [fake],
        Environment = environmentId,
        StaleAfter = staleAfter,
        DayFraction = () => fake.DayFraction,
    };
    runtimes.Add(new EnvironmentRuntime(environmentId, view, fake, state, snapshots, store));
}
var environments = new EnvironmentSet(runtimes, registry.DefaultEnvironmentId);

builder.Services.AddSingleton(registries);
builder.Services.AddSingleton<IRegistryProvider>(registries);
builder.Services.AddHostedService(sp => new RegistryReloader(
    registries, registryPath, TimeSpan.FromSeconds(builder.Configuration.GetValue("Registry:WatchSeconds", 5.0)), sp.GetRequiredService<ILogger<RegistryReloader>>()));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(environments);
builder.Services.AddSingleton<ISnapshotNotifier, SignalRSnapshotNotifier>();
foreach (var rt in runtimes)
{
    // AddHostedService would keep only the first of each type, so these are added as plain services
    builder.Services.AddSingleton<IHostedService>(sp => new SourcePoller([rt.Fake], rt.Registry, rt.State, sp.GetRequiredService<ILogger<SourcePoller>>()));
    builder.Services.AddSingleton<IHostedService>(sp => new SnapshotPublisher(rt.Builder, rt.Store, sp.GetRequiredService<ISnapshotNotifier>(), snapshotInterval, sp.GetRequiredService<ILogger<SnapshotPublisher>>()));
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

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", town = registries.Current.Town.Name }))
   .ExcludeFromDescription();

// Which environment an endpoint answers for is the ?env= of its address; without one, the default environment.
app.MapGet("/api/environments", (EnvironmentSet envs) =>
        envs.All.Select(e => new EnvironmentInfo(e.Id, e.Registry.Current.ActiveEnvironment?.Name ?? e.Id, e.Id == envs.Default.Id)))
   .Produces<EnvironmentInfo[]>()
   .WithName("GetEnvironments");

app.MapGet("/api/snapshot/latest", (EnvironmentSet envs, string? env) =>
        envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env)
        : rt.Store.Latest is { } s ? Results.Ok(s) : Results.StatusCode(StatusCodes.Status503ServiceUnavailable))
   .Produces<Snapshot>()
   .WithName("GetLatestSnapshot");

// Demo steering for the fake generator. The Break things panel (a later slice) is built on this.
var fx = app.MapGroup("/api/fake").ExcludeFromDescription();
fx.MapGet("/", (EnvironmentSet envs, string? env) =>
    envs.Find(env) is { } rt ? Results.Ok(new { calm = rt.Fake.Calm, effects = rt.Fake.Effects }) : EnvironmentNotFound(envs, env));
fx.MapPost("/effects", (EffectRequest r, EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    if (r.Target is null) return Results.BadRequest("target is required");
    try { return Results.Ok(rt.Fake.Add(r.Target, r.Kind, r.Intensity)); }
    catch (ArgumentException e) { return Results.BadRequest(e.Message); }
});
fx.MapDelete("/effects/{id}", (string id, EnvironmentSet envs, string? env) =>
    envs.Find(env) is not { } rt ? EnvironmentNotFound(envs, env) : rt.Fake.Remove(id) ? Results.NoContent() : Results.NotFound());
fx.MapDelete("/effects", (EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    rt.Fake.Clear();
    return Results.NoContent();
});
fx.MapPost("/reset", (EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    rt.Fake.Reset();
    return Results.NoContent();
});
fx.MapPost("/calm", (CalmRequest r, EnvironmentSet envs, string? env) =>
{
    if (envs.Find(env) is not { } rt) return EnvironmentNotFound(envs, env);
    rt.Fake.Calm = r.On;
    return Results.Ok(new { calm = rt.Fake.Calm });
});

static IResult EnvironmentNotFound(EnvironmentSet envs, string? env) =>
    Results.NotFound(new { error = $"No environment '{env}'.", environments = envs.All.Select(e => e.Id) });

app.MapHub<TownHub>("/hubs/town");

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
}

app.Run();

record EffectRequest(string? Target, FakeEffectKind Kind, double Intensity);
record CalmRequest(bool On);

// Lets tests use WebApplicationFactory<Program>.
public partial class Program;
