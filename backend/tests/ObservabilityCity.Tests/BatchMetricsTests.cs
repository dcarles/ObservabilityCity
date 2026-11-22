using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Rebuilding the past asks the metrics API about many resources of one subscription and region in one batch call instead of one call each. The numbers are the same as the
/// one-by-one reads give, a batch the cloud refuses is made smaller and then read one by one, and the live poll never uses a batch.
/// </summary>
public class BatchMetricsTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    private static readonly DateTimeOffset Frame = DateTimeOffset.Parse("2025-12-30T09:05:00Z");

    private static async Task<(AzureMonitorSource Source, TownRegistry Registry)> Platform(CannedHttp http, bool batch, ICredentialSource? login = null)
    {
        var registry = RegistryLoader.Load(TownA, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, TownA);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        var definition = env.Sources.Single(s => s.Name == "platform") with { Connection = null };
        definition = definition with { Typed = AzureSettings.Of(definition) with { BatchMetrics = batch } };
        var source = new AzureMonitorSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, login, env.Scope, set.Scope, TownA));
        return ((AzureMonitorSource)source, registry);
    }

    /// <summary>One point a minute from <paramref name="from"/> to <paramref name="to"/>, whose value is the hour it starts in times ten: the same numbers whichever way they are asked for.</summary>
    private static List<Dictionary<string, object>> Points(DateTimeOffset from, DateTimeOffset to, string aggregation)
    {
        var points = new List<Dictionary<string, object>>();
        for (var t = from; t < to; t = t.AddMinutes(1))
            points.Add(new Dictionary<string, object> { ["timeStamp"] = t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"), [aggregation] = t.Hour * 10 });
        return points;
    }

    private static HttpResponseMessage Single(SentRequest request)
    {
        var query = System.Web.HttpUtility.ParseQueryString(request.Uri!.Query);
        var span = query["timespan"]!.Split('/');
        var points = Points(DateTimeOffset.Parse(span[0]), DateTimeOffset.Parse(span[1]), query["aggregation"]!.ToLowerInvariant());
        var value = query["metricnames"]!.Split(',').Select(n => new { name = new { value = n }, timeseries = new[] { new { data = points } } });
        return CannedHttp.Reply(JsonSerializer.Serialize(new { value }));
    }

    private static HttpResponseMessage Batch(SentRequest request)
    {
        var query = System.Web.HttpUtility.ParseQueryString(request.Uri!.Query);
        var points = Points(DateTimeOffset.Parse(query["starttime"]!), DateTimeOffset.Parse(query["endtime"]!), query["aggregation"]!.ToLowerInvariant());
        var ids = JsonDocument.Parse(request.Body).RootElement.GetProperty("resourceids").EnumerateArray().Select(e => e.GetString()!).ToList();
        var values = ids.Select(id => new
        {
            resourceid = id,
            value = query["metricnames"]!.Split(',').Select(n => new { name = new { value = n }, timeseries = new[] { new { data = points } } }),
        });
        return CannedHttp.Reply(JsonSerializer.Serialize(new { values }));
    }

    private static bool IsBatch(SentRequest r) => r.Method == HttpMethod.Post;

    private static void AssertSameReadings(IReadOnlyDictionary<string, NodeReading> expected, IReadOnlyDictionary<string, NodeReading> actual)
    {
        Assert.Equal(expected.Keys.Order(), actual.Keys.Order());
        foreach (var (id, reading) in expected)
        {
            Assert.Equal(reading.Cpu, actual[id].Cpu);
            Assert.Equal(reading.Memory, actual[id].Memory);
            Assert.Equal(reading.Utilisation, actual[id].Utilisation);
            Assert.Equal(reading.Throttled, actual[id].Throttled);
        }
    }

    [Fact]
    public async Task A_batch_gives_the_same_readings_as_one_call_for_each_resource_in_far_fewer_calls()
    {
        var one = new CannedHttp().Respond(Single);
        var (alone, registry) = await Platform(one, batch: false);
        var many = new CannedHttp().Respond(r => IsBatch(r) ? Batch(r) : Single(r));
        var login = new StaticLogin("secret-token");
        var (batched, _) = await Platform(many, batch: true, login);

        var expected = await alone.PollAtAsync(registry, Frame, CancellationToken.None);
        var actual = await batched.PollAtAsync(registry, Frame, CancellationToken.None);

        AssertSameReadings(expected, actual);
        Assert.Contains(actual.Values, r => r.Utilisation is not null);
        var posts = many.Sent.Where(IsBatch).ToList();
        Assert.NotEmpty(posts);
        Assert.True(many.Sent.Count < one.Sent.Count, $"{many.Sent.Count} calls with batches, {one.Sent.Count} one by one");
        // the accounts' four kinds of question go to the batch endpoint of their region, 50 at a time at most, with the batch login
        var first = posts[0];
        Assert.StartsWith("https://northeurope.metrics.monitor.azure.com/subscriptions/", first.Uri!.ToString());
        Assert.Contains("/metrics:getBatch?api-version=2023-10-01", first.Uri.ToString());
        Assert.Equal("microsoft.documentdb/databaseaccounts", System.Web.HttpUtility.ParseQueryString(first.Uri.Query)["metricnamespace"]);
        Assert.InRange(JsonDocument.Parse(first.Body).RootElement.GetProperty("resourceids").GetArrayLength(), 1, AzureMonitorReader.BatchLimit);
        Assert.Equal("Bearer secret-token", first.Headers["Authorization"]);
        Assert.Contains("https://metrics.monitor.azure.com/.default", login.Scopes);
        // the plans have no region in the inventory, so they are still read one by one
        Assert.Contains(many.Sent, r => !IsBatch(r) && r.Uri!.AbsolutePath.Contains("/serverfarms/"));
        Assert.DoesNotContain(many.Sent, r => !IsBatch(r) && r.Uri!.AbsolutePath.Contains("/databaseAccounts/", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task The_frames_of_the_three_hours_that_a_batch_read_cost_no_more_calls_and_the_log_counts_the_resources_read_in_batches()
    {
        var http = new CannedHttp().Respond(r => IsBatch(r) ? Batch(r) : Single(r));
        var (source, registry) = await Platform(http, batch: true);

        await source.PollAtAsync(registry, Frame, CancellationToken.None);
        var calls = http.Sent.Count;
        await source.PollAtAsync(registry, Frame.AddMinutes(30), CancellationToken.None);
        await source.PollAtAsync(registry, Frame.AddMinutes(65), CancellationToken.None);

        Assert.Equal(calls, http.Sent.Count);
        var stats = ((IPastReadStats)source).TakeStats();
        Assert.True(stats.Batched > 0);
        Assert.Equal(0, stats.Singly);
        Assert.Null(stats.Note);
        Assert.Equal(calls, stats.Calls);
        Assert.True(stats.CacheHits > 0);
    }

    [Fact]
    public async Task The_stats_say_how_long_the_reads_of_each_group_of_metrics_took_longest_first_and_start_again_when_taken()
    {
        var http = new CannedHttp().Respond(r => IsBatch(r) ? Batch(r) : Single(r));
        var (source, registry) = await Platform(http, batch: true);

        await source.PollAtAsync(registry, Frame, CancellationToken.None);

        var groups = ((IPastReadStats)source).TakeStats().Groups!;
        Assert.NotEmpty(groups);
        Assert.All(groups, g => { Assert.Contains(": ", g.Name); Assert.True(g.Reads > 0); Assert.True(g.Seconds >= 0); });
        Assert.Equal(groups.OrderByDescending(g => g.Seconds).Select(g => g.Name), groups.Select(g => g.Name));
        Assert.Empty(((IPastReadStats)source).TakeStats().Groups!);
    }

    [Fact]
    public async Task A_batch_the_login_may_not_make_is_asked_once_and_the_resources_are_read_one_by_one_with_the_same_numbers()
    {
        var one = new CannedHttp().Respond(Single);
        var (alone, registry) = await Platform(one, batch: false);
        var refused = new CannedHttp().Respond(r => IsBatch(r) ? CannedHttp.Reply("""{"error":{"code":"AuthorizationFailed","message":"no"}}""", HttpStatusCode.Forbidden) : Single(r));
        var (source, _) = await Platform(refused, batch: true);

        var expected = await alone.PollAtAsync(registry, Frame, CancellationToken.None);
        var actual = await source.PollAtAsync(registry, Frame, CancellationToken.None);

        AssertSameReadings(expected, actual);
        Assert.Equal(1, refused.Sent.Count(IsBatch)); // a refusal is not tried again in smaller pieces
        var stats = ((IPastReadStats)source).TakeStats();
        Assert.Equal(0, stats.Batched);
        Assert.True(stats.Singly > 0);
        Assert.Contains("403", stats.Note);
    }

    [Fact]
    public async Task A_batch_that_is_too_big_is_made_smaller_twice_and_then_read_one_by_one_and_the_hour_is_not_lost()
    {
        var one = new CannedHttp().Respond(Single);
        var (alone, registry) = await Platform(one, batch: false);
        var tooBig = new CannedHttp().Respond(r => IsBatch(r)
            ? CannedHttp.Reply("""{"error":{"code":"BadRequest","message":"The response size exceeded maximum limit of 8MB."}}""", HttpStatusCode.BadRequest)
            : Single(r));
        var (source, _) = await Platform(tooBig, batch: true);

        var expected = await alone.PollAtAsync(registry, Frame, CancellationToken.None);
        var actual = await source.PollAtAsync(registry, Frame, CancellationToken.None);

        AssertSameReadings(expected, actual);
        // the town has a few accounts in each of its subscriptions: for each, one batch of up to 50, the same in pieces of 25, and in pieces of 10
        var subscriptions = tooBig.Sent.Where(IsBatch).Select(r => r.Uri!.AbsolutePath.Split('/')[2]).Distinct().Count();
        Assert.Equal(AzureMonitorSource.BatchSizes.Length * subscriptions, tooBig.Sent.Count(IsBatch));
        Assert.True(((IPastReadStats)source).TakeStats().Singly > 0);
    }

    [Fact]
    public async Task An_answer_that_has_nothing_for_a_resource_or_is_not_a_batch_answer_is_never_taken_for_data()
    {
        var one = new CannedHttp().Respond(Single);
        var (alone, registry) = await Platform(one, batch: false);
        var wrong = new CannedHttp().Respond(r => IsBatch(r) ? Single(r) : Single(r)); // answers a batch with the shape of a single resource
        var (source, _) = await Platform(wrong, batch: true);

        var actual = await source.PollAtAsync(registry, Frame, CancellationToken.None);

        AssertSameReadings(await alone.PollAtAsync(registry, Frame, CancellationToken.None), actual);
        Assert.Equal(0, ((IPastReadStats)source).TakeStats().Batched);
    }

    /// <summary>The answer of the batch with the entry of <paramref name="quiet"/> left empty: Azure sends no metric for an account that had nothing to report.</summary>
    private static HttpResponseMessage BatchWithQuiet(SentRequest request, string? quiet)
    {
        var query = System.Web.HttpUtility.ParseQueryString(request.Uri!.Query);
        var points = Points(DateTimeOffset.Parse(query["starttime"]!), DateTimeOffset.Parse(query["endtime"]!), query["aggregation"]!.ToLowerInvariant());
        var ids = JsonDocument.Parse(request.Body).RootElement.GetProperty("resourceids").EnumerateArray().Select(e => e.GetString()!).ToList();
        var values = ids.Select(id => new
        {
            resourceid = id,
            value = id.Equals(quiet, StringComparison.OrdinalIgnoreCase)
                ? Array.Empty<object>()
                : query["metricnames"]!.Split(',').Select(n => new { name = new { value = n }, timeseries = new[] { new { data = points } } }).ToArray<object>(),
        });
        return CannedHttp.Reply(JsonSerializer.Serialize(new { values }));
    }

    /// <summary>What a read of one resource gives for an account with nothing to report: its metrics, with no points.</summary>
    private static HttpResponseMessage SingleWithQuiet(SentRequest request, string? quiet)
    {
        if (quiet is null || !request.Uri!.AbsolutePath.Contains(quiet, StringComparison.OrdinalIgnoreCase)) return Single(request);
        var query = System.Web.HttpUtility.ParseQueryString(request.Uri.Query);
        var value = query["metricnames"]!.Split(',').Select(n => new { name = new { value = n }, timeseries = Array.Empty<object>() });
        return CannedHttp.Reply(JsonSerializer.Serialize(new { value }));
    }

    [Fact]
    public async Task A_metric_Azure_has_no_data_for_is_no_failure_the_batch_is_kept_and_nothing_is_logged()
    {
        // the first resource of the first batch is a quiet account
        string? quiet = null;
        var batched = new CannedHttp().Respond(r =>
        {
            if (!IsBatch(r)) return SingleWithQuiet(r, quiet);
            quiet ??= JsonDocument.Parse(r.Body).RootElement.GetProperty("resourceids")[0].GetString();
            return BatchWithQuiet(r, quiet);
        });
        var (source, registry) = await Platform(batched, batch: true);

        var actual = await source.PollAtAsync(registry, Frame, CancellationToken.None);

        var one = new CannedHttp().Respond(r => SingleWithQuiet(r, quiet));
        var (alone, _) = await Platform(one, batch: false);
        AssertSameReadings(await alone.PollAtAsync(registry, Frame, CancellationToken.None), actual); // the same numbers as when each is read alone, the quiet account has none
        var stats = ((IPastReadStats)source).TakeStats();
        Assert.True(stats.Batched > 0);
        Assert.Equal(0, stats.Singly); // nothing was read again, and the quiet account is not one of the resources read alone
        Assert.Null(stats.Note);
        Assert.Equal(await BatchCallsOfAnAnswerWithNothingWrong(registry), batched.Sent.Count(IsBatch)); // no batch was asked again in smaller pieces
    }

    private static async Task<int> BatchCallsOfAnAnswerWithNothingWrong(TownRegistry registry)
    {
        var http = new CannedHttp().Respond(r => IsBatch(r) ? Batch(r) : Single(r));
        var (source, _) = await Platform(http, batch: true);
        await source.PollAtAsync(registry, Frame, CancellationToken.None);
        return http.Sent.Count(IsBatch);
    }

    [Fact]
    public async Task A_resource_the_answer_says_nothing_about_is_read_on_its_own_and_the_others_keep_their_batch_answer()
    {
        string? missing = null;
        var http = new CannedHttp().Respond(r =>
        {
            if (!IsBatch(r)) return Single(r);
            var ids = JsonDocument.Parse(r.Body).RootElement.GetProperty("resourceids").EnumerateArray().Select(e => e.GetString()!).ToList();
            missing ??= ids[0];
            var full = JsonDocument.Parse(Batch(r).Content.ReadAsStringAsync().Result).RootElement.GetProperty("values").EnumerateArray().Where(e => !e.GetProperty("resourceid").GetString()!.Equals(missing, StringComparison.OrdinalIgnoreCase));
            return CannedHttp.Reply(JsonSerializer.Serialize(new { values = full }));
        });
        var (source, registry) = await Platform(http, batch: true);
        var (alone, _) = await Platform(new CannedHttp().Respond(Single), batch: false);

        var actual = await source.PollAtAsync(registry, Frame, CancellationToken.None);

        AssertSameReadings(await alone.PollAtAsync(registry, Frame, CancellationToken.None), actual);
        var stats = ((IPastReadStats)source).TakeStats();
        Assert.True(stats.Batched > 0); // the others of the batch were not thrown away
        Assert.True(stats.Singly > 0);
        Assert.Null(stats.Note); // nothing failed, so nothing is logged as a failure
        Assert.Contains(http.Sent, r => !IsBatch(r) && r.Uri!.AbsolutePath.Contains(missing!, StringComparison.OrdinalIgnoreCase));
        Assert.Equal(await BatchCallsOfAnAnswerWithNothingWrong(registry), http.Sent.Count(IsBatch)); // and no batch was asked again in smaller pieces
    }

    [Fact]
    public async Task The_live_poll_never_uses_a_batch()
    {
        var http = new CannedHttp().Respond(r => IsBatch(r) ? Batch(r) : Single(r));
        var (source, registry) = await Platform(http, batch: true);

        await source.PollAsync(registry, CancellationToken.None);

        Assert.DoesNotContain(http.Sent, IsBatch);
        Assert.NotEmpty(http.Sent);
    }

    [Fact]
    public async Task Batches_can_be_switched_off_for_a_source()
    {
        var http = new CannedHttp().Respond(r => IsBatch(r) ? Batch(r) : Single(r));
        var (source, registry) = await Platform(http, batch: false);

        await source.PollAtAsync(registry, Frame, CancellationToken.None);

        Assert.DoesNotContain(http.Sent, IsBatch);
    }

    [Fact]
    public void A_batch_answer_is_read_like_the_answer_for_each_resource_and_one_cut_at_the_series_limit_says_so()
    {
        var call = new MetricCall("microsoft.documentdb/databaseaccounts", "count", null);
        var json = JsonSerializer.Serialize(new
        {
            values = new[]
            {
                new { resourceid = "/subscriptions/s/Providers/a", value = new[] { new { name = new { value = "TotalRequests" }, timeseries = new[] { new { data = new[] { new { timeStamp = "2026-01-01T00:00:00Z", count = 5 } } } } } } },
                new { resourceid = "/subscriptions/s/Providers/b", value = new[] { new { name = new { value = "TotalRequests" }, timeseries = Enumerable.Range(0, AzureMonitorReader.MaxSeries).Select(_ => new { data = new[] { new { timeStamp = "2026-01-01T00:00:00Z", count = 1 } } }).ToArray() } } },
            },
        });

        var answers = AzureMonitorReader.ParseBatch(json, call, null);

        var a = answers["/SUBSCRIPTIONS/s/providers/A"]; // ids are not case sensitive
        Assert.False(a.Cut);
        Assert.Equal([5.0], Assert.Single(a.Series).Points);
        Assert.True(answers["/subscriptions/s/providers/b"].Cut);
        Assert.Throws<InvalidOperationException>(() => AzureMonitorReader.ParseBatch("""{"value":[]}""", call, null));
    }

    [Fact]
    public void The_batch_call_names_the_region_the_subscription_the_namespace_and_the_split_like_the_single_call_does()
    {
        var call = new MetricCall("microsoft.documentdb/databaseaccounts", "count", "StatusCode eq '429'", "PT5M");

        var url = AzureMonitorReader.BatchUrl("northeurope", "sub-1", "microsoft.documentdb/databaseaccounts", call, ["TotalRequests"], DateTimeOffset.Parse("2026-01-01T03:00:00Z"), TimeSpan.FromHours(3), "CollectionName");

        var query = System.Web.HttpUtility.ParseQueryString(new Uri(url).Query);
        Assert.StartsWith("https://northeurope.metrics.monitor.azure.com/subscriptions/sub-1/metrics:getBatch?", url);
        Assert.Equal("2026-01-01T00:00:00Z", query["starttime"]);
        Assert.Equal("2026-01-01T03:00:00Z", query["endtime"]);
        Assert.Equal("StatusCode eq '429' and CollectionName eq '*'", query["filter"]);
        Assert.Equal(AzureMonitorReader.MaxSeries.ToString(), query["top"]);
        Assert.Equal("PT5M", query["interval"]);
        Assert.Equal("count", query["aggregation"]);
    }
}
