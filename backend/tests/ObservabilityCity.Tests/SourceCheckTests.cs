using System.Net;
using System.Text;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>`validate --sources`: the probes against canned HTTP answers (no live Azure) and the report over an environment folder.</summary>
public class SourceCheckTests
{
    private sealed class FakeTokens : ITokenProvider
    {
        public List<string> Scopes { get; } = [];
        public Task<string> GetTokenAsync(string scope, CancellationToken ct) { Scopes.Add(scope); return Task.FromResult("token"); }
    }

    private sealed class NoLogin : ITokenProvider
    {
        public Task<string> GetTokenAsync(string scope, CancellationToken ct) => throw new Azure.Identity.CredentialUnavailableException("not logged in");
    }

    /// <summary>Answers every request with one canned response, or throws, and remembers what was asked.</summary>
    private sealed class Canned(HttpStatusCode status, string body, Exception? fail = null) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request);
            if (fail is not null) throw fail;
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private static ISourceProbe Probe(string kind, Canned handler, ITokenProvider? tokens = null, string? grafanaToken = "g-token") =>
        SourceProbes.For(new HttpClient(handler), tokens ?? new FakeTokens(), grafanaToken).Single(p => p.Kind == kind);

    private const string PrometheusData = """{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"up"},"value":[1,"1"]}]}}""";
    private const string PrometheusNone = """{"status":"success","data":{"resultType":"vector","result":[]}}""";
    private const string LogRows = """{"tables":[{"name":"PrimaryResult","columns":[{"name":"T","type":"string"}],"rows":[["AppRequests"]]}]}""";
    private const string LogNoRows = """{"tables":[{"name":"PrimaryResult","columns":[],"rows":[]}]}""";
    private const string TopicFeed = "<feed><entry><title>orders</title></entry></feed>";
    private const string GrafanaHit = """[{"id":1,"title":"Overview"}]""";

    [Theory]
    [InlineData("prometheus", "https://prom.example.test", PrometheusData, "https://prometheus.monitor.azure.com/.default")]
    [InlineData("loganalytics", "00000000-0000-0000-0000-000000000001", LogRows, "https://api.loganalytics.io/.default")]
    [InlineData("servicebus", "sb-example.servicebus.windows.net", TopicFeed, "https://servicebus.azure.net/.default")]
    public async Task A_source_that_answers_with_data_is_connected_and_asked_with_the_azure_login(string kind, string connection, string body, string scope)
    {
        var tokens = new FakeTokens();
        var handler = new Canned(HttpStatusCode.OK, body);

        var r = await Probe(kind, handler, tokens).ProbeAsync(connection, TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.Connected, r.Status);
        Assert.Equal([scope], tokens.Scopes);
        Assert.Equal("Bearer", Assert.Single(handler.Requests).Headers.Authorization?.Scheme);
    }

    [Fact]
    public async Task Grafana_is_probed_with_the_service_account_token()
    {
        var handler = new Canned(HttpStatusCode.OK, GrafanaHit);

        var r = await Probe("grafana-irm", handler).ProbeAsync("https://grafana.example.test/", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.Connected, r.Status);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("g-token", request.Headers.Authorization?.Parameter);
        Assert.Equal("https://grafana.example.test/api/search?limit=1", request.RequestUri?.ToString());
    }

    [Fact]
    public async Task Grafana_without_a_token_says_no_permission_and_asks_for_nothing()
    {
        var handler = new Canned(HttpStatusCode.OK, GrafanaHit);

        var r = await Probe("grafana-irm", handler, grafanaToken: null).ProbeAsync("https://grafana.example.test", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.NoPermission, r.Status);
        Assert.Contains("GRAFANA_TOKEN", r.Detail);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("prometheus", PrometheusNone)]
    [InlineData("loganalytics", LogNoRows)]
    [InlineData("servicebus", "<feed></feed>")]
    [InlineData("grafana-irm", "[]")]
    public async Task A_source_that_answers_with_nothing_is_empty(string kind, string body)
    {
        var r = await Probe(kind, new Canned(HttpStatusCode.OK, body)).ProbeAsync("https://x.example.test", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.Empty, r.Status);
    }

    [Theory]
    [InlineData("prometheus", HttpStatusCode.Forbidden)]
    [InlineData("loganalytics", HttpStatusCode.Unauthorized)]
    [InlineData("servicebus", HttpStatusCode.Forbidden)]
    [InlineData("grafana-irm", HttpStatusCode.Unauthorized)]
    public async Task A_refusal_is_no_permission(string kind, HttpStatusCode status)
    {
        var r = await Probe(kind, new Canned(status, "{}")).ProbeAsync("https://x.example.test", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.NoPermission, r.Status);
    }

    [Theory]
    [InlineData("prometheus")]
    [InlineData("loganalytics")]
    [InlineData("servicebus")]
    [InlineData("grafana-irm")]
    public async Task A_server_error_or_a_connection_failure_is_unreachable(string kind)
    {
        var broken = await Probe(kind, new Canned(HttpStatusCode.BadGateway, "")).ProbeAsync("https://x.example.test", TestContext.Current.CancellationToken);
        var down = await Probe(kind, new Canned(HttpStatusCode.OK, "", new HttpRequestException("name not resolved"))).ProbeAsync("https://x.example.test", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.Unreachable, broken.Status);
        Assert.Equal(ProbeStatus.Unreachable, down.Status);
        Assert.Contains("name not resolved", down.Detail);
    }

    [Fact]
    public async Task An_answer_that_is_not_json_is_unreachable_not_connected()
    {
        var r = await Probe("prometheus", new Canned(HttpStatusCode.OK, "<html>sign in</html>")).ProbeAsync("https://x.example.test", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.Unreachable, r.Status);
    }

    [Fact]
    public async Task No_azure_login_is_no_permission_and_tells_you_to_log_in()
    {
        var r = await Probe("prometheus", new Canned(HttpStatusCode.OK, PrometheusData), new NoLogin()).ProbeAsync("https://x.example.test", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.NoPermission, r.Status);
        Assert.Contains("az login", r.Detail);
    }

    [Fact]
    public async Task A_source_with_no_connection_is_not_configured()
    {
        var handler = new Canned(HttpStatusCode.OK, PrometheusData);

        var r = await Probe("prometheus", handler).ProbeAsync("  ", TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.NotConfigured, r.Status);
        Assert.Empty(handler.Requests);
    }

    private static void WriteEnvironment(RegistryCopy f, string yaml)
    {
        Directory.CreateDirectory(f.FilePath("environments"));
        f.Write("environments/dev.yaml", yaml);
    }

    private static async Task<SourceCheckResult> Run(RegistryCopy f, Canned handler) =>
        await SourceCheck.RunAsync(f.Path, SourceProbes.For(new HttpClient(handler), new FakeTokens(), "g"), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

    private static SourceFinding Find(SourceCheckResult r, string env, string signal) => r.Findings.Single(x => x.Environment == env && x.Signal == signal);

    [Fact]
    public async Task The_sample_town_is_all_fake_so_it_connects_and_leaves_other_signals_unconfigured()
    {
        using var f = new RegistryCopy(TestPaths.Registry);

        var r = await Run(f, new Canned(HttpStatusCode.OK, "{}"));

        Assert.Equal(0, r.Failures);
        Assert.Equal(ProbeStatus.Connected, Find(r, "dev", "metrics").Result.Status);
        Assert.Equal(ProbeStatus.NotConfigured, Find(r, "dev", "messaging").Result.Status);
        Assert.Equal(0, SourceCheck.ExitCode([r], strict: true));
    }

    private static void ConfigureRealSources(RegistryCopy f) =>
        WriteEnvironment(f, """
            name: Development
            sources:
              metrics: { kind: prometheus, connection: "https://prom.example.test" }
              incidents: { kind: grafana-irm, connection: "https://grafana.example.test" }
              messaging: { kind: servicebus, connection: "sb-example.servicebus.windows.net" }
            """);

    [Fact]
    public async Task Each_configured_source_of_an_environment_is_reported_by_signal()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        ConfigureRealSources(f);

        var r = await Run(f, new Canned(HttpStatusCode.Forbidden, "{}"));

        var dev = r.Findings.Where(x => x.Environment == "dev").ToList();
        Assert.Equal(["metrics", "incidents", "messaging"], dev.OrderBy(x => Array.IndexOf(SourceCheck.Signals, x.Signal)).Select(x => x.Signal));
        Assert.All(dev, x => Assert.Equal(ProbeStatus.NoPermission, x.Result.Status));
        Assert.Equal("prometheus", Find(r, "dev", "metrics").Kind);
        Assert.Equal(3, r.Failures);
    }

    [Fact]
    public async Task A_failure_makes_the_exit_code_non_zero_but_empty_does_so_only_when_strict()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        ConfigureRealSources(f);

        var denied = await Run(f, new Canned(HttpStatusCode.Forbidden, "{}"));
        var empty = await Run(f, new Canned(HttpStatusCode.OK, "[]"));

        Assert.Equal(1, SourceCheck.ExitCode([denied], strict: false));
        Assert.True(empty.EmptyCount > 0);
        Assert.Equal(0, SourceCheck.ExitCode([empty], strict: false));
        Assert.Equal(1, SourceCheck.ExitCode([empty], strict: true));
    }

    [Fact]
    public async Task An_unknown_kind_is_a_failure_that_names_the_known_ones()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        WriteEnvironment(f, "name: Development\nsources:\n  metrics: { kind: statsd, connection: \"x\" }\n");

        var r = await Run(f, new Canned(HttpStatusCode.OK, "{}"));

        var hit = Find(r, "dev", "metrics");
        Assert.Equal(ProbeStatus.UnknownKind, hit.Result.Status);
        Assert.Contains("prometheus", hit.Result.Detail);
        Assert.Equal(1, SourceCheck.ExitCode([r], strict: false));
    }

    [Fact]
    public async Task A_probe_that_hangs_is_cut_off_and_reported_unreachable()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        ConfigureRealSources(f);
        var probes = new ISourceProbe[] { new Hanging("prometheus"), new Hanging("grafana-irm"), new Hanging("servicebus") };

        var r = await SourceCheck.RunAsync(f.Path, probes, TimeSpan.FromMilliseconds(50), TestContext.Current.CancellationToken);

        Assert.Equal(ProbeStatus.Unreachable, Find(r, "dev", "metrics").Result.Status);
        Assert.Contains("timed out", Find(r, "dev", "metrics").Result.Detail);
    }

    private sealed class Hanging(string kind) : ISourceProbe
    {
        public string Kind => kind;
        public async Task<ProbeResult> ProbeAsync(string connection, CancellationToken ct)
        {
            await Task.Delay(Timeout.Infinite, ct);
            return new ProbeResult(ProbeStatus.Connected);
        }
    }

    [Fact]
    public async Task The_report_says_which_environment_signal_and_what_happened()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        ConfigureRealSources(f);
        var r = await Run(f, new Canned(HttpStatusCode.Forbidden, "{}"));
        var w = new StringWriter();

        SourceCheck.WriteText(r, TestPaths.RepoRoot, w);

        Assert.Contains("no permission", w.ToString());
        Assert.Contains("metrics", w.ToString());
        Assert.Contains("prometheus", w.ToString());
    }
}
