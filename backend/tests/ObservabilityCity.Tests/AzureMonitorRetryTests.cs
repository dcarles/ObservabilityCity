using System.Net;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;

namespace ObservabilityCity.Tests;

/// <summary>
/// Azure Monitor now and then answers a read with a hiccup (busy, unavailable, a dropped connection) that passes a moment later. Such a read is tried again a couple of
/// times before it counts as failed, so one hiccup does not blank the buildings that use it for a whole round; a refusal is not a hiccup and fails at once.
/// </summary>
public class AzureMonitorRetryTests
{
    private const string Answer = """{ "value": [ { "name": { "value": "CpuPercentage" }, "timeseries": [ { "data": [ { "average": 40 } ] } ] } ] }""";
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    private static readonly MetricCall Call = new(null, "average", null, AzureMonitorReader.Interval);

    private static Task<IReadOnlyList<MetricSeries>> Read(CannedHttp http) =>
        new AzureMonitorReader(new HttpClient(http), null, TimeSpan.Zero).ReadAsync("/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/serverfarms/plan-x", Call, ["CpuPercentage"], T0, TimeSpan.FromMinutes(5), CancellationToken.None);

    [Theory]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.BadGateway)]
    public async Task A_hiccup_is_tried_again_and_the_read_succeeds(HttpStatusCode hiccup)
    {
        var http = new CannedHttp().Answer("upstream connect error", hiccup).Answer(Answer);

        var series = await Read(http);

        Assert.Single(series);
        Assert.Equal(2, http.Sent.Count);
    }

    [Fact]
    public async Task A_dropped_connection_is_tried_again()
    {
        var calls = 0;
        var http = new CannedHttp().Respond(_ => ++calls == 1 ? throw new HttpRequestException("connection termination") : CannedHttp.Reply(Answer));

        Assert.Single(await Read(http));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task A_read_that_keeps_failing_gives_up_after_three_tries_and_says_what_Azure_answered()
    {
        var http = CannedHttp.Always("upstream connect error", HttpStatusCode.ServiceUnavailable);

        var ex = await Assert.ThrowsAsync<HttpRequestException>(() => Read(http));

        Assert.Contains("503", ex.Message);
        Assert.Equal(AzureMonitorReader.Attempts, http.Sent.Count);
    }

    [Fact]
    public async Task A_refusal_is_not_tried_again()
    {
        var http = CannedHttp.Always("denied", HttpStatusCode.Forbidden);

        var ex = await Assert.ThrowsAsync<HttpRequestException>(() => Read(http));

        Assert.Contains("403", ex.Message);
        Assert.Single(http.Sent);
    }
}
