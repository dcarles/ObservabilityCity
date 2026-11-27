using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// The calls an API serves: the routes query returns one row per service, HTTP method and route, the source turns the rows into rates, and the snapshot lists the busiest
/// few and how the requests divide by method. Nothing in the core knows a metric or a property name; the query says them.
/// </summary>
public class RouteMetricsTests
{
    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);

    [Fact]
    public void The_routes_rows_name_the_service_the_method_the_route_and_the_calls()
    {
        var rows = LogAnalyticsReader.ParseRoutes("""{"tables":[{"columns":[{"name":"AppRoleName"},{"name":"role"},{"name":"method"},{"name":"route"},{"name":"calls"},{"name":"errors"}],"rows":[["x","Account","GET","account/{id}",30,3],["x","Account","POST","",5,0],["x","Account","POST","account",8,"2"],["x","","GET","a",1,0]]}]}""");

        Assert.Equal([("Account", "GET", "account/{id}", 30.0, 3.0), ("Account", "POST", "account", 8.0, 2.0)], rows.Select(r => (r.Role, r.Method, r.Route, r.Calls, r.Errors)));
        var bad = Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.ParseRoutes("""{"tables":[{"columns":[{"name":"role"},{"name":"calls"}],"rows":[]}]}"""));
        Assert.Contains("role, method, route and calls", bad.Message);
    }

    [Fact]
    public void Errors_may_be_left_out_and_the_hourly_form_carries_the_time_bin()
    {
        var rows = LogAnalyticsReader.ParseRoutes("""{"tables":[{"columns":[{"name":"role"},{"name":"method"},{"name":"route"},{"name":"calls"},{"name":"at"}],"rows":[["Api","GET","r",10,"2026-01-01T00:05:00Z"]]}]}""");

        Assert.Equal(0, rows[0].Errors);
        Assert.Equal(DateTimeOffset.Parse("2026-01-01T00:05:00Z"), rows[0].At);
    }

    [Fact]
    public void A_services_routes_are_rates_over_the_window_with_the_methods_spelt_one_way()
    {
        var asked = new[] { new SystemScope("aa.orders-api", null, "Orders", null, null, null, []) };
        var rows = new[]
        {
            new SpanRow("Orders", 600, 6, 100),
            };
        var routes = new[]
        {
            new RouteRow("Orders", "get", "orders/{id}", 300, 3), new RouteRow("Orders", "GET", "orders/{id}", 150, 0),
            new RouteRow("Orders", "POST", "orders", 150, 30), new RouteRow("Other", "GET", "x", 999, 0),
        };

        var reading = LogAnalyticsSource.Readings(asked, rows, TimeSpan.FromMinutes(5), DateTimeOffset.UnixEpoch, null, routes)["aa.orders-api"];

        Assert.Equal(2, reading.Routes!.Count);
        var get = reading.Routes.Single(r => r.Method == "GET");
        Assert.Equal(1.5, get.PerSecond, 6); // 450 calls in 300 seconds
        Assert.Equal(3.0 / 450, get.ErrorRate, 6);
        var post = reading.Routes.Single(r => r.Method == "POST");
        Assert.Equal(0.5, post.PerSecond, 6);
        Assert.Equal(0.2, post.ErrorRate, 6);
    }

    [Fact]
    public void A_service_with_no_routes_rows_has_no_routes_and_a_town_without_a_routes_query_asks_for_none()
    {
        var asked = new[] { new SystemScope("aa.orders-api", null, "Orders", null, null, null, []) };
        Assert.Null(LogAnalyticsSource.Readings(asked, [new SpanRow("Orders", 10, 0, 1)], TimeSpan.FromMinutes(5), DateTimeOffset.UnixEpoch)["aa.orders-api"].Routes);
        Assert.Null(LogAnalyticsSource.Readings(asked, [new SpanRow("Orders", 10, 0, 1)], TimeSpan.FromMinutes(5), DateTimeOffset.UnixEpoch, null, [])["aa.orders-api"].Routes);
    }

    [Fact]
    public void The_snapshot_lists_the_busiest_routes_and_splits_by_method_from_all_of_them()
    {
        var routes = new List<RouteReading>
        {
            new("GET", "a", 40, 0), new("GET", "b", 20, 0.1), new("GET", "c", 10, 0), new("POST", "d", 8, 0.5), new("PUT", "e", 2, 0), new("DELETE", "f", 1, 0), new("get", "g", 19, 0),
        };

        var top = RouteSummary.TopRoutes(routes)!;
        Assert.Equal(RouteSummary.Top, top.Count);
        Assert.Equal(["a", "b", "g", "c", "d"], top.Select(r => r.Route)); // highest first
        Assert.Equal(0.5, top.Single(r => r.Route == "d").ErrorRate);

        var methods = RouteSummary.ByMethod(routes)!;
        Assert.Equal(["GET", "POST", "PUT", "DELETE"], methods.Select(m => m.Method));
        Assert.Equal(89, methods[0].PerSecond, 6); // every route counts, not only the busiest five
        Assert.Equal(1.0, methods.Sum(m => m.Share), 6);
    }

    [Fact]
    public void Nothing_measured_is_no_list_not_an_empty_one()
    {
        Assert.Null(RouteSummary.TopRoutes(null));
        Assert.Null(RouteSummary.TopRoutes([]));
        Assert.Null(RouteSummary.ByMethod([new RouteReading("GET", "a", 0, 0)]));
    }

    [Theory]
    [InlineData("galactic-credit")]
    [InlineData("droid-shop")]
    public async Task The_demo_towns_show_the_busiest_calls_of_each_api_and_their_methods_add_up_to_its_rate(string town)
    {
        var folder = Path.Combine(TestPaths.RepoRoot, "config", town);
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 26, 8, 0, 0, TimeSpan.Zero));
        var registry = RegistryLoader.Load(folder);
        var fake = new FakeSource(FakeProfiles.Load(folder), new FakeOptions(), clock);
        var state = new LatestState();
        var builder = new SnapshotBuilder(registry, state, clock) { StaleAfter = TimeSpan.FromSeconds(3), FixedAssets = FakeAssets.Load(folder) };
        for (var i = 0; i < 3; i++) { clock.Advance(TimeSpan.FromSeconds(1)); state.Update(await fake.PollAsync(registry, TestContext.Current.CancellationToken)); }
        var snapshot = builder.Build();

        var apis = snapshot.Groups.SelectMany(g => g.Nodes).Where(n => n.Kind == NodeKind.Api && n.State != HealthState.Down && n.RequestsPerSecond > 0).ToList();
        Assert.NotEmpty(apis);
        foreach (var api in apis)
        {
            Assert.Equal(RouteSummary.Top, api.Routes!.Count);
            Assert.True(api.Routes.Zip(api.Routes.Skip(1)).All(p => p.First.PerSecond >= p.Second.PerSecond));
            var methods = api.Methods!;
            Assert.Equal(api.RequestsPerSecond, methods.Sum(m => m.PerSecond), 3);
            Assert.Equal(1.0, methods.Sum(m => m.Share), 3);
        }
        // a database, a broker or a worker serves no routes
        Assert.All(snapshot.Groups.SelectMany(g => g.Nodes).Where(n => n.Kind is NodeKind.Database or NodeKind.Worker), n => Assert.Null(n.Routes));
    }
}
