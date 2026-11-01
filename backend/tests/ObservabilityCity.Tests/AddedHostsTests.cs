using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Host;

namespace ObservabilityCity.Tests;

/// <summary>
/// Hosts added from the Unknown hosts panel: saved in the town's <c>_discovered/third-parties.yaml</c>, read by the registry next to the config file
/// (which wins on a clash), and applied at once by the server. A copy of the discovery town is used so each test may write to its folder.
/// </summary>
public class AddedHostsTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _folder = Directory.CreateTempSubdirectory().FullName;

    public AddedHostsTests()
    {
        var from = Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "discovery-town");
        foreach (var file in Directory.GetFiles(from, "*", SearchOption.AllDirectories).Where(f => !Path.GetRelativePath(from, f).StartsWith("_discovered")))
        {
            var target = Path.Combine(_folder, Path.GetRelativePath(from, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
    }

    public void Dispose() => Directory.Delete(_folder, true);

    private static AddedHost Vendor(string host, params string[] calledBy) => new(host, AddedHosts.VendorKind, calledBy);

    // ---- the file ----

    [Fact]
    public void Adding_saves_in_the_discovered_folder_a_host_is_in_the_file_once_and_removing_takes_it_out()
    {
        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));
        AddedHosts.Add(_folder, new AddedHost("noise.example.test", AddedHosts.IgnoreKind, []));
        AddedHosts.Add(_folder, new AddedHost("Files.example.test", AddedHosts.InternalKind, ["aa.orders-api"])); // the same host again: it changes kind, it does not repeat

        Assert.True(File.Exists(Path.Combine(_folder, "_discovered", "third-parties.yaml")));
        Assert.Equal(["noise.example.test", "Files.example.test"], AddedHosts.Read(_folder).Select(a => a.Host).ToArray());
        Assert.Equal(AddedHosts.InternalKind, AddedHosts.Read(_folder).Single(a => a.Host.StartsWith("Files")).Kind);
        Assert.True(AddedHosts.Remove(_folder, "FILES.example.test"));
        Assert.False(AddedHosts.Remove(_folder, "files.example.test"));
        Assert.Equal(["noise.example.test"], AddedHosts.Read(_folder).Select(a => a.Host).ToArray());
    }

    [Fact]
    public void A_damaged_file_is_read_as_empty_and_the_town_still_loads()
    {
        Directory.CreateDirectory(Path.Combine(_folder, "_discovered"));
        File.WriteAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"), "added: [ this is : not : yaml");
        Assert.Empty(AddedHosts.Read(_folder));
        Assert.NotEmpty(RegistryLoader.LoadResilient(_folder).Vendors);
    }

    [Theory]
    [InlineData("files.example.test", true)]
    [InlineData("a", true)]
    [InlineData("https://files.example.test", false)]
    [InlineData("files.example.test/path", false)]
    [InlineData("files.example.test:8080", false)]
    [InlineData("", false)]
    [InlineData("-bad.example.test", false)]
    public void Only_a_plain_host_name_can_be_added(string host, bool plain) => Assert.Equal(plain, AddedHosts.IsHostName(host));

    // ---- the registry ----

    [Fact]
    public void An_added_vendor_becomes_a_building_called_by_who_called_it_and_an_internal_one_is_marked_so()
    {
        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));
        AddedHosts.Add(_folder, new AddedHost("ours.example.test", AddedHosts.InternalKind, ["bb.ledger-worker"]));

        var vendors = RegistryLoader.LoadResilient(_folder).Vendors;

        var files = Assert.Single(vendors, v => v.Node.Id == "ext.files-example-test");
        Assert.Equal(["aa.orders-api"], files.CalledBy);
        Assert.Equal(["files.example.test"], files.Domains);
        Assert.False(files.Internal);
        var ours = Assert.Single(vendors, v => v.Node.Id == "ext.ours-example-test");
        Assert.True(ours.Internal);
        Assert.Contains(vendors, v => v.Node.Id == "ext.bureau"); // the config file's vendors are still there
    }

    [Fact]
    public void The_config_file_wins_when_it_has_the_same_id()
    {
        File.AppendAllText(Path.Combine(_folder, "third-parties.yaml"), "  - { id: ext.files-example-test, name: Files from the file, calledBy: [bb.ledger-api] }\n");
        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));

        var vendor = Assert.Single(RegistryLoader.LoadResilient(_folder).Vendors, v => v.Node.Id == "ext.files-example-test");

        Assert.Equal("Files from the file", vendor.Node.Name);
        Assert.Equal(["bb.ledger-api"], vendor.CalledBy);
    }

    [Fact]
    public void An_ignored_host_is_added_to_the_ignore_list_of_every_environment_that_finds_links()
    {
        AddedHosts.Add(_folder, new AddedHost("noise.example.test", AddedHosts.IgnoreKind, []));

        var links = RegistryLoader.LoadResilient(_folder).Environments.Single(e => e.Links is not null).Links!;

        Assert.Contains(@"^noise\.example\.test$", links.IgnoreHosts);
        Assert.Contains(@"^169\.254\.", links.IgnoreHosts); // the file's own patterns stay
        Assert.Matches(links.IgnoreHosts.Last(), "noise.example.test");
        Assert.DoesNotMatch(links.IgnoreHosts.Last(), "xnoise.example.test.evil");
    }

    // ---- the server ----

    private WebApplicationFactory<Program> Server() => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:Path", _folder);
        b.UseSetting("Registry:WatchSeconds", "0");
    });

    private static ObservabilityCity.Core.Links.DiscoveredLinks Discovered(WebApplicationFactory<Program> server) =>
        server.Services.GetRequiredService<TownSet>().Default.Environments.Default.Discovered!;

    private static readonly DateOnly[] Days = [new(2026, 10, 28), new(2026, 10, 29)];

    [Fact]
    public async Task Adding_a_host_saves_it_loads_the_town_again_and_takes_it_off_the_unknown_list_and_removing_undoes_it()
    {
        using var server = Server();
        var client = server.CreateClient();
        Discovered(server).RecordUnresolved("aa.orders-api", "files.example.test", "/v1", Days, 100);
        Discovered(server).RecordUnresolved("ext.bureau", "files.example.test", "/v2", Days, 5); // a vendor building called it too: not a system of the town
        var towns = server.Services.GetRequiredService<TownSet>();

        var add = await client.PostAsJsonAsync("/api/added-hosts", new AddHostRequest("files.example.test", "vendor"));

        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        var list = (await add.Content.ReadFromJsonAsync<List<AddedHostSnapshot>>(Json))!;
        Assert.Equal("files.example.test", Assert.Single(list).Host);
        Assert.Equal(["aa.orders-api"], list[0].CalledBy);
        Assert.Contains(towns.Default.Registry.Current.Vendors, v => v.Node.Id == "ext.files-example-test"); // loaded again at once
        Assert.DoesNotContain(Discovered(server).UnknownHosts(2), h => h.Host == "files.example.test");
        Assert.Single(await client.GetFromJsonAsync<List<AddedHostSnapshot>>("/api/added-hosts", Json) ?? []);

        var remove = await client.DeleteAsync("/api/added-hosts?host=files.example.test");

        Assert.Equal(HttpStatusCode.OK, remove.StatusCode);
        Assert.Empty((await remove.Content.ReadFromJsonAsync<List<AddedHostSnapshot>>(Json))!);
        Assert.DoesNotContain(towns.Default.Registry.Current.Vendors, v => v.Node.Id == "ext.files-example-test");
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/added-hosts?host=files.example.test")).StatusCode);
    }

    [Fact]
    public async Task A_host_that_is_not_plain_a_wrong_kind_nobody_called_or_an_id_the_file_has_is_refused_and_nothing_is_saved()
    {
        using var server = Server();
        var client = server.CreateClient();
        Discovered(server).RecordUnresolved("ext.bureau", "vendors-only.example.test", null, Days, 10);
        Discovered(server).RecordUnresolved("aa.orders-api", "ext-bureau.example.test", null, Days, 10);

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/added-hosts", new AddHostRequest("https://x.example.test/a", "vendor"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/added-hosts", new AddHostRequest("x.example.test", "partner"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/added-hosts", new AddHostRequest("vendors-only.example.test", "vendor"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/added-hosts", new AddHostRequest("never-seen.example.test", "internal"))).StatusCode);
        Assert.Empty(AddedHosts.Read(_folder));
    }

    [Fact]
    public async Task Ignoring_a_host_needs_no_caller_and_is_applied_to_the_links_of_the_environment()
    {
        using var server = Server();
        var client = server.CreateClient();
        Discovered(server).RecordUnresolved("ext.bureau", "noise.example.test", null, Days, 10);

        var response = await client.PostAsJsonAsync("/api/added-hosts", new AddHostRequest("noise.example.test", "ignore"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var towns = server.Services.GetRequiredService<TownSet>();
        Assert.Contains(@"^noise\.example\.test$", towns.Default.Registry.Current.ForEnvironment("prod").ActiveEnvironment!.Links!.IgnoreHosts);
        Assert.DoesNotContain(Discovered(server).UnknownHosts(2), h => h.Host == "noise.example.test");
    }
}
