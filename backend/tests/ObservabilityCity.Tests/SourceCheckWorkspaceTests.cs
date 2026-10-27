using System.Net;
using System.Text;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>
/// `validate --sources` for a Log Analytics source that gives no connection: the workspace comes from the environment's scope, the same way the running
/// town finds it (an id as it is, a name or wildcard looked up through Resource Graph), instead of reporting "no connection given".
/// </summary>
public class SourceCheckWorkspaceTests
{
    private sealed class Tokens : ITokenProvider
    {
        public Task<string> GetTokenAsync(string scope, CancellationToken ct) => Task.FromResult("token");
    }

    private sealed class Canned(string graphBody) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request);
            var body = request.RequestUri!.Host == "management.azure.com" ? graphBody : """{"tables":[{"rows":[["x"]]}]}""";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private const string Workspaces = """
        {"data":[
          {"id":"/subscriptions/s/resourceGroups/r/providers/Microsoft.OperationalInsights/workspaces/log-example-prod","name":"log-example-prod","customerId":"00000000-0000-0000-0000-0000000000aa"},
          {"id":"/subscriptions/s/resourceGroups/r/providers/Microsoft.OperationalInsights/workspaces/log-example-test","name":"log-example-test","customerId":"00000000-0000-0000-0000-0000000000bb"}]}
        """;

    private static string Folder(string scope)
    {
        var folder = Path.Combine(Path.GetTempPath(), "oc-sources-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(folder, "environments"));
        File.WriteAllText(Path.Combine(folder, "environments", "prod.yaml"), $$"""
            name: Production
            sources:
              telemetry: { kind: loganalytics, connection: "" }
            {{scope}}
            """);
        return folder;
    }

    private static async Task<(SourceFinding Finding, Canned Http)> Run(string scope)
    {
        var http = new Canned(Workspaces);
        var client = new HttpClient(http);
        var tokens = new Tokens();
        var check = await SourceCheck.RunAsync(Folder(scope), SourceProbes.Default(client, tokens), TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken,
            ["loganalytics"], new ResourceGraphWorkspaceLookup(client, tokens));
        return (check.Findings.Single(f => f.Signal == "telemetry"), http);
    }

    [Fact]
    public async Task A_workspace_name_in_the_scope_is_looked_up_and_probed_by_its_id()
    {
        var (finding, http) = await Run("""
            scope:
              variables: { env: prod }
              workspace: "log-*-{env}"
            """);

        Assert.Equal(ProbeStatus.Connected, finding.Result.Status);
        Assert.Contains("log-example-prod", finding.Result.Detail);
        Assert.Contains(http.Requests, r => r.RequestUri!.AbsolutePath.EndsWith("/workspaces/00000000-0000-0000-0000-0000000000aa/query"));
    }

    [Fact]
    public async Task A_workspace_id_in_the_scope_is_used_as_it_is_and_nothing_is_looked_up()
    {
        var (finding, http) = await Run("""
            scope:
              workspaceId: "00000000-0000-0000-0000-0000000000cc"
              workspace: "log-*"
            """);

        Assert.Equal(ProbeStatus.Connected, finding.Result.Status);
        Assert.DoesNotContain(http.Requests, r => r.RequestUri!.Host == "management.azure.com");
        Assert.Contains(http.Requests, r => r.RequestUri!.AbsolutePath.Contains("00000000-0000-0000-0000-0000000000cc"));
    }

    [Fact]
    public async Task A_pattern_that_matches_several_workspaces_is_reported_with_their_names()
    {
        var (finding, _) = await Run("""
            scope:
              workspace: "log-example-*"
            """);

        Assert.Equal(ProbeStatus.Unreachable, finding.Result.Status);
        Assert.Contains("2 workspaces match", finding.Result.Detail);
        Assert.Contains("log-example-test", finding.Result.Detail);
    }

    [Fact]
    public async Task A_pattern_that_matches_nothing_is_reported()
    {
        var (finding, _) = await Run("""
            scope:
              workspace: "nothing-*"
            """);

        Assert.Equal(ProbeStatus.Unreachable, finding.Result.Status);
        Assert.Contains("no workspace is named", finding.Result.Detail);
    }

    [Fact]
    public async Task Without_a_scope_the_source_is_still_reported_as_having_no_connection()
    {
        var (finding, http) = await Run("");

        Assert.Equal(ProbeStatus.NotConfigured, finding.Result.Status);
        Assert.Empty(http.Requests);
    }
}
