using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using ObservabilityCity.Host;

namespace ObservabilityCity.Tests;

/// <summary>
/// The server answers only this machine's own pages: a request from another site (Origin) or addressed to another name (Host, for DNS rebinding) is refused,
/// on the REST endpoints, the demo steering and the SignalR hub alike. Mini town.
/// </summary>
public class HostSecurityTests : IDisposable
{
    private static WebApplicationFactory<Program> Factory(params string[] allowedOrigins) => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:Path", TestPaths.MiniTown);
        b.UseSetting("Registry:WatchSeconds", "0");
        for (var i = 0; i < allowedOrigins.Length; i++) b.UseSetting($"Security:AllowedOrigins:{i}", allowedOrigins[i]);
    });

    private readonly WebApplicationFactory<Program> _factory = Factory();

    public void Dispose() => _factory.Dispose();

    private static HttpRequestMessage Request(HttpMethod method, string url, string? origin = null, string? host = null)
    {
        var r = new HttpRequestMessage(method, url);
        if (origin is not null) r.Headers.TryAddWithoutValidation("Origin", origin);
        if (host is not null) r.Headers.Host = host;
        return r;
    }

    private async Task<HttpStatusCode> Send(HttpRequestMessage request, WebApplicationFactory<Program>? factory = null) =>
        (await (factory ?? _factory).CreateClient().SendAsync(request, TestContext.Current.CancellationToken)).StatusCode;

    [Fact]
    public async Task A_request_with_no_origin_is_answered()
    {
        Assert.Equal(HttpStatusCode.OK, await Send(Request(HttpMethod.Get, "/api/towns")));
    }

    [Theory]
    [InlineData("http://localhost:5173")]
    [InlineData("http://127.0.0.1:5291")]
    [InlineData("http://[::1]:5080")]
    public async Task A_page_served_from_this_machine_is_answered(string origin)
    {
        Assert.Equal(HttpStatusCode.OK, await Send(Request(HttpMethod.Get, "/api/towns", origin)));
    }

    [Theory]
    [InlineData("https://evil.example")]
    [InlineData("http://localhost.evil.example")]
    [InlineData("http://127.0.0.1.evil.example:5173")]
    [InlineData("null")]
    [InlineData("file://")]
    public async Task A_page_from_another_site_is_refused(string origin)
    {
        Assert.Equal(HttpStatusCode.Forbidden, await Send(Request(HttpMethod.Get, "/api/towns", origin)));
    }

    [Fact]
    public async Task The_hub_refuses_a_foreign_origin_before_it_says_anything()
    {
        // a WebSocket can skip the negotiate call, so the upgrade request itself is what is checked
        Assert.Equal(HttpStatusCode.Forbidden, await Send(Request(HttpMethod.Post, "/hubs/town/negotiate?negotiateVersion=1&town=x", "https://evil.example")));
        Assert.Equal(HttpStatusCode.Forbidden, await Send(Request(HttpMethod.Get, "/hubs/town?town=x", "https://evil.example")));
    }

    [Fact]
    public async Task The_hub_negotiates_with_a_local_origin()
    {
        Assert.Equal(HttpStatusCode.OK, await Send(Request(HttpMethod.Post, "/hubs/town/negotiate?negotiateVersion=1", "http://localhost:5173")));
    }

    [Theory]
    [InlineData("/api/fake/reset")]
    [InlineData("/api/fake/story/stop")]
    public async Task Demo_steering_cannot_be_triggered_from_another_site(string path)
    {
        Assert.Equal(HttpStatusCode.Forbidden, await Send(Request(HttpMethod.Post, path, "https://evil.example")));
    }

    [Fact]
    public async Task A_write_endpoint_cannot_be_called_from_another_site()
    {
        Assert.Equal(HttpStatusCode.Forbidden, await Send(Request(HttpMethod.Post, "/api/health-events/dismiss", "https://evil.example")));
    }

    [Theory]
    [InlineData("evil.example")]
    [InlineData("localhost.evil.example")]
    public async Task A_request_addressed_to_another_name_is_refused(string host)
    {
        // DNS rebinding points an attacker's own name at this machine: the page is then "same origin", so only the Host header gives it away
        Assert.Equal(HttpStatusCode.BadRequest, await Send(Request(HttpMethod.Get, "/api/towns", host: host)));
    }

    [Theory]
    [InlineData("localhost")]
    [InlineData("localhost:5080")]
    [InlineData("127.0.0.1:5080")]
    public async Task A_request_addressed_to_this_machine_is_answered(string host)
    {
        Assert.Equal(HttpStatusCode.OK, await Send(Request(HttpMethod.Get, "/api/towns", host: host)));
    }

    [Fact]
    public async Task An_origin_the_deployment_lists_is_answered_and_others_are_not()
    {
        using var hosted = Factory("https://city.example.test/");

        Assert.Equal(HttpStatusCode.OK, await Send(Request(HttpMethod.Get, "/api/towns", "https://city.example.test"), hosted));
        Assert.Equal(HttpStatusCode.Forbidden, await Send(Request(HttpMethod.Get, "/api/towns", "https://other.example.test"), hosted));
    }

    [Theory]
    [InlineData("http://localhost", true)]
    [InlineData("HTTP://LOCALHOST:1", true)]
    [InlineData("http://localhost:5173/", true)]
    [InlineData("ftp://localhost", false)]
    [InlineData("localhost", false)]
    [InlineData("http://localhost@evil.example", false)]
    [InlineData("", false)]
    public void The_guard_reads_an_origin_strictly(string origin, bool expected)
    {
        Assert.Equal(expected, new OriginGuard(_ => Task.CompletedTask, []).IsAllowed(origin));
    }
}
