using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Host;

var builder = WebApplication.CreateBuilder(args);

var registryPath = RegistryPath.Resolve(builder.Configuration);
var registry = RegistryLoader.Load(registryPath);

var fakeOptions = builder.Configuration.GetSection("Fake").Get<FakeOptions>() ?? new FakeOptions();
var fake = new FakeSource(FakeProfiles.Load(registryPath), fakeOptions, TimeProvider.System);
var snapshotInterval = TimeSpan.FromSeconds(builder.Configuration.GetValue("Snapshot:IntervalSeconds", 2.0));

builder.Services.AddSingleton(registry);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<LatestState>();
builder.Services.AddSingleton<SnapshotStore>();
builder.Services.AddSingleton(fake);
builder.Services.AddSingleton<IFakeControl>(fake);
builder.Services.AddSingleton<IMetricSource>(fake);
builder.Services.AddSingleton<ISnapshotNotifier, SignalRSnapshotNotifier>();
builder.Services.AddSingleton(sp => new SnapshotBuilder(
    sp.GetRequiredService<Registry>(), sp.GetRequiredService<LatestState>(), sp.GetRequiredService<TimeProvider>())
{
    Environment = "demo",
    DayFraction = () => fake.DayFraction,
});
builder.Services.AddHostedService<SourcePoller>();
builder.Services.AddHostedService(sp => new SnapshotPublisher(
    sp.GetRequiredService<SnapshotBuilder>(), sp.GetRequiredService<SnapshotStore>(),
    sp.GetRequiredService<ISnapshotNotifier>(), snapshotInterval));
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
builder.Services.AddSignalR();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SupportNonNullableReferenceTypes();
    c.SchemaFilter<RequireAllPropertiesFilter>();
});

var app = builder.Build();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", town = registry.Town.Name }))
   .ExcludeFromDescription();

app.MapGet("/api/snapshot/latest", (SnapshotStore store) =>
        store.Latest is { } s ? Results.Ok(s) : Results.StatusCode(StatusCodes.Status503ServiceUnavailable))
   .Produces<Snapshot>()
   .WithName("GetLatestSnapshot");

// Demo steering for the fake generator. The Break things panel (a later slice) is built on this.
var fx = app.MapGroup("/api/fake").ExcludeFromDescription();
fx.MapGet("/", (IFakeControl c) => new { calm = c.Calm, effects = c.Effects });
fx.MapPost("/effects", (EffectRequest r, IFakeControl c) =>
    r.Target is null ? Results.BadRequest("target is required") : Results.Ok(c.Add(r.Target, r.Kind, r.Intensity)));
fx.MapDelete("/effects/{id}", (string id, IFakeControl c) => c.Remove(id) ? Results.NoContent() : Results.NotFound());
fx.MapDelete("/effects", (IFakeControl c) => { c.Clear(); return Results.NoContent(); });
fx.MapPost("/calm", (CalmRequest r, IFakeControl c) => { c.Calm = r.On; return Results.Ok(new { calm = c.Calm }); });

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
