using System.Net;
using System.Net.Http.Headers;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// A live environment polls its cloud only while a browser looks at it (and shortly after), and asks Azure again at the pace Azure says when it is throttling.
/// </summary>
public class DemandTests
{
    [Fact]
    public void Nobody_looking_is_not_wanted_one_browser_is_and_a_leaver_is_wanted_for_the_grace_only()
    {
        var clock = new FakeTimeProvider();
        var demand = new Demand(TimeSpan.FromMinutes(2), clock);

        Assert.False(demand.Wanted); // at startup nobody looks

        demand.Join();
        demand.Join();
        demand.Leave();
        Assert.True(demand.Wanted);

        demand.Leave();
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.True(demand.Wanted); // a reload must not stop the work
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.False(demand.Wanted);

        demand.Leave(); // a stray leave never makes the count negative
        demand.Join();
        Assert.True(demand.Wanted);
    }

    [Fact]
    public void Always_on_wants_the_work_with_nobody_looking()
    {
        var demand = new Demand(TimeSpan.Zero) { AlwaysOn = true };
        Assert.True(demand.Wanted);
    }

    [Fact]
    public async Task Waiting_returns_at_once_when_wanted_and_when_a_browser_joins_and_gives_up_when_cancelled()
    {
        var demand = new Demand(TimeSpan.Zero);
        Assert.True(await Demand.WaitUntilWantedAsync(null, CancellationToken.None)); // no demand at all (a demo environment) never waits

        var waiting = Demand.WaitUntilWantedAsync(demand, TestContext.Current.CancellationToken);
        await Task.Delay(100, TestContext.Current.CancellationToken);
        Assert.False(waiting.IsCompleted);
        demand.Join();
        Assert.True(await waiting.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
        Assert.True(await Demand.WaitUntilWantedAsync(demand, TestContext.Current.CancellationToken));

        var idle = new Demand(TimeSpan.Zero);
        using var cancel = new CancellationTokenSource();
        var cancelled = Demand.WaitUntilWantedAsync(idle, cancel.Token);
        cancel.Cancel();
        Assert.False(await cancelled.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
    }

    private sealed class Counting : IMetricSource
    {
        public int Polls;
        public string Name => "counting";
        public TimeSpan PollInterval => TimeSpan.FromMilliseconds(40);
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry registry, CancellationToken ct)
        {
            Interlocked.Increment(ref Polls);
            return Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(new Dictionary<string, NodeReading>());
        }
    }

    [Fact]
    public async Task A_poller_waits_while_nobody_looks_polls_when_a_browser_joins_and_stops_again_when_it_leaves()
    {
        var ct = TestContext.Current.CancellationToken;
        var demand = new Demand(TimeSpan.Zero);
        var source = new Counting();
        var poller = new SourcePoller([source], new RegistryHolder(RegistryLoader.Load(TestPaths.LiveTown)), new LatestState(), NullLogger<SourcePoller>.Instance, demand: demand);

        await poller.StartAsync(ct);
        await Task.Delay(300, ct);
        Assert.Equal(0, source.Polls); // not one cloud call for an environment nobody has open

        demand.Join();
        await WaitFor(() => source.Polls >= 3, ct);

        demand.Leave();
        await Task.Delay(200, ct); // a round in flight may finish
        var stopped = source.Polls;
        await Task.Delay(300, ct);
        Assert.Equal(stopped, source.Polls);

        demand.Join(); // opened again: polling carries on at once
        await WaitFor(() => source.Polls > stopped, ct);
        await poller.StopAsync(ct);
    }

    private static async Task WaitFor(Func<bool> done, CancellationToken ct)
    {
        for (var i = 0; i < 100 && !done(); i++) await Task.Delay(50, ct);
        Assert.True(done());
    }

    [Fact]
    public void The_wait_follows_Retry_After_in_seconds_or_as_a_date_capped_and_with_jitter_and_grows_without_it()
    {
        var now = DateTimeOffset.Parse("2026-11-09T10:00:00Z");
        HttpResponseHeaders Headers(Action<HttpResponseHeaders> set)
        {
            var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            set(response.Headers);
            return response.Headers;
        }

        var seconds = Headers(h => h.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(7)));
        Assert.Equal(TimeSpan.FromSeconds(7), RetryWait.For(seconds, 1, null, now, 0));
        Assert.Equal(TimeSpan.FromSeconds(7 * 1.25), RetryWait.For(seconds, 1, null, now, 1));

        var date = Headers(h => h.RetryAfter = new RetryConditionHeaderValue(now.AddSeconds(12)));
        Assert.Equal(TimeSpan.FromSeconds(12), RetryWait.For(date, 2, null, now, 0));

        var huge = Headers(h => h.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromMinutes(10)));
        Assert.Equal(RetryWait.Longest, RetryWait.For(huge, 1, null, now, 0));

        Assert.Equal(TimeSpan.FromMilliseconds(400), RetryWait.For(null, 1, null, now, 0));
        Assert.Equal(TimeSpan.FromMilliseconds(800), RetryWait.For(null, 2, null, now, 0));
        Assert.Equal(TimeSpan.Zero, RetryWait.For(seconds, 1, TimeSpan.Zero, now, 1)); // tests ask for no waiting at all
    }

    [Fact]
    public async Task Log_Analytics_tries_a_throttled_query_again_and_a_refusal_not_at_all()
    {
        const string workspace = "00000000-0000-0000-0000-000000000000";
        var throttled = new CannedHttp().Answer("slow down", HttpStatusCode.TooManyRequests).Answer("""{ "tables": [ { "columns": [ { "name": "resourceId" }, { "name": "job" } ], "rows": [] } ] }""");
        var reader = new LogAnalyticsReader(new HttpClient(throttled), null, TimeSpan.Zero);
        await reader.QueryJobsAsync(workspace, "q", TimeSpan.FromHours(1), TestContext.Current.CancellationToken);
        Assert.Equal(2, throttled.Sent.Count);

        var refused = CannedHttp.Always("no", HttpStatusCode.Forbidden);
        await Assert.ThrowsAsync<HttpRequestException>(() => new LogAnalyticsReader(new HttpClient(refused), null, TimeSpan.Zero).QueryJobsAsync(workspace, "q", TimeSpan.FromHours(1), TestContext.Current.CancellationToken));
        Assert.Single(refused.Sent);

        var never = CannedHttp.Always("busy", HttpStatusCode.ServiceUnavailable);
        await Assert.ThrowsAsync<HttpRequestException>(() => new LogAnalyticsReader(new HttpClient(never), null, TimeSpan.Zero).QueryJobsAsync(workspace, "q", TimeSpan.FromHours(1), TestContext.Current.CancellationToken));
        Assert.Equal(AzureMonitorReader.Attempts, never.Sent.Count);
    }

    [Fact]
    public void Ids_in_a_path_are_remembered_as_one_entry_and_a_gateway_lists_only_its_busiest_paths()
    {
        Assert.Equal("/orders/id/lines/id", ObservabilityCity.Core.Links.DiscoveredLinks.Tidy("/orders/12345/lines/3f2504e0-4f89-11d3-9a0c-0305e82c3301"));
        Assert.Equal("/orders/id", ObservabilityCity.Core.Links.DiscoveredLinks.Tidy("/orders/deadbeefdeadbeefdeadbeef"));
        Assert.Equal("/v2/orders/summary", ObservabilityCity.Core.Links.DiscoveredLinks.Tidy("/v2/orders/summary")); // words and short names are not ids
        Assert.Equal("", ObservabilityCity.Core.Links.DiscoveredLinks.Tidy(null));

        var store = new ObservabilityCity.Core.Links.DiscoveredLinks();
        store.Judge(_ => false, host => host == "gw.example.test");
        var day = new[] { new DateOnly(2026, 11, 8) };
        for (var i = 0; i < 1000; i++) store.RecordUnresolved("aa.orders", "gw.example.test", $"/orders/{i}", day, 1);
        for (var i = 0; i < 80; i++) store.RecordUnresolved("aa.orders", "gw.example.test", $"/page{i}", day, 100 - i);

        var host = Assert.Single(store.UnknownHosts(1));
        Assert.Equal(ObservabilityCity.Core.Links.DiscoveredLinks.MaxPathsPerHost, host.Paths!.Count);
        Assert.Equal(81 - ObservabilityCity.Core.Links.DiscoveredLinks.MaxPathsPerHost, host.MorePaths); // 1,000 order ids became one path, and 80 pages are 81 paths in all
        Assert.Equal("/page0", host.Paths[0].Path); // busiest first
    }

    [Fact]
    public void The_store_keeps_no_more_than_a_fixed_number_of_new_addresses_but_goes_on_counting_the_ones_it_has()
    {
        var store = new ObservabilityCity.Core.Links.DiscoveredLinks();
        var day = new[] { new DateOnly(2026, 11, 8) };
        for (var i = 0; i < ObservabilityCity.Core.Links.DiscoveredLinks.MaxAddresses + 50; i++) store.RecordUnresolved("aa.orders", $"h{i}.example.test", null, day, 1);
        Assert.Equal(ObservabilityCity.Core.Links.DiscoveredLinks.MaxAddresses, store.UnknownHosts(1).Count);

        store.RecordUnresolved("aa.orders", "h0.example.test", null, day, 40);
        Assert.Equal(40, store.UnknownHosts(1).Single(h => h.Host == "h0.example.test").Calls);
    }
}
