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

    private static AddHost Vendor(string host, params string[] calledBy) => new(host, AddedHosts.VendorKind, calledBy);

    // ---- the file ----

    [Fact]
    public void Adding_saves_in_the_discovered_folder_a_host_is_in_the_file_once_and_removing_takes_it_out()
    {
        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));
        AddedHosts.Add(_folder, new AddHost("noise.example.test", AddedHosts.IgnoreKind, []));
        AddedHosts.Add(_folder, new AddHost("Files.example.test", AddedHosts.InternalKind, ["aa.orders-api"])); // the same host again: it changes kind, it does not repeat

        Assert.True(File.Exists(Path.Combine(_folder, "_discovered", "third-parties.yaml")));
        var all = AddedHosts.Read(_folder);
        Assert.Equal(["ext.files-example-test", @"^noise\.example\.test$"], all.Select(a => a.Id).ToArray());
        Assert.Equal(AddedHosts.InternalKind, all[0].Kind);
        Assert.Equal("noise.example.test", all[1].Host);
        Assert.True(AddedHosts.Remove(_folder, "EXT.files-example-test"));
        Assert.True(AddedHosts.Remove(_folder, @"^noise\.example\.test$"));
        Assert.False(AddedHosts.Remove(_folder, "ext.files-example-test"));
        Assert.Empty(AddedHosts.Read(_folder));
    }

    [Fact]
    public void The_file_has_the_shape_of_third_parties_yaml_and_what_was_edited_by_hand_survives_the_next_save()
    {
        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));
        AddedHosts.Add(_folder, new AddHost("noise.example.test", AddedHosts.IgnoreKind, []));
        var text = File.ReadAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"));
        Assert.Contains("vendors:", text);
        Assert.Contains("ignoreHosts:", text);
        Assert.Contains("id: ext.files-example-test", text);
        Assert.Contains("domains:", text);
        Assert.DoesNotContain("added:", text);

        // a name, an SLA and a service written by hand
        File.WriteAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"), text.Replace("name: files.example.test", "name: File store\n  slaP99Ms: 900"));
        AddedHosts.Add(_folder, Vendor("other.example.test", "bb.ledger-api"));

        var after = File.ReadAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"));
        Assert.Contains("name: File store", after);
        Assert.Contains("slaP99Ms: 900", after);
        var vendor = Assert.Single(RegistryLoader.LoadResilient(_folder).Vendors, v => v.Node.Id == "ext.files-example-test");
        Assert.Equal("File store", vendor.Node.Name);
        Assert.Equal(900, vendor.Node.SlaP99Ms);
    }

    [Fact]
    public void A_file_of_the_first_version_with_added_entries_is_read_and_saved_in_the_new_shape()
    {
        Directory.CreateDirectory(Path.Combine(_folder, "_discovered"));
        File.WriteAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"),
            "added:\n- host: api.partner.test\n  kind: vendor\n  calledBy:\n  - aa.orders-api\n- host: noise.example.test\n  kind: ignore\n");

        var all = AddedHosts.Read(_folder);
        Assert.DoesNotContain("added:", File.ReadAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"))); // converted on the first read, so it can be edited at once
        Assert.Equal(["ext.api-partner-test", @"^noise\.example\.test$"], all.Select(a => a.Id).ToArray());
        Assert.Equal(["aa.orders-api"], all[0].CalledBy);
        Assert.Contains(RegistryLoader.LoadResilient(_folder).Vendors, v => v.Node.Id == "ext.api-partner-test");

        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));

        var text = File.ReadAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"));
        Assert.DoesNotContain("added:", text);
        Assert.Contains("id: ext.api-partner-test", text);
        Assert.Equal(3, AddedHosts.Read(_folder).Count);
    }

    [Fact]
    public void Ignoring_a_host_that_was_added_as_a_vendor_replaces_it()
    {
        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));
        AddedHosts.Add(_folder, new AddHost("files.example.test", AddedHosts.IgnoreKind, []));

        Assert.Equal(AddedHosts.IgnoreKind, Assert.Single(AddedHosts.Read(_folder)).Kind);
    }

    [Fact]
    public void A_change_to_the_file_by_hand_is_noticed_by_the_folder_watch_but_other_files_in_the_discovered_folder_are_not()
    {
        var before = RegistryReloader.Fingerprint(_folder);
        Directory.CreateDirectory(Path.Combine(_folder, "_discovered", "links"));
        File.WriteAllText(Path.Combine(_folder, "_discovered", "links", "state.yaml"), "x: 1\n");
        Assert.Equal(before, RegistryReloader.Fingerprint(_folder));

        AddedHosts.Add(_folder, Vendor("files.example.test", "aa.orders-api"));

        Assert.NotEqual(before, RegistryReloader.Fingerprint(_folder));
    }

    [Fact]
    public void A_damaged_file_is_read_as_empty_and_the_town_still_loads()
    {
        Directory.CreateDirectory(Path.Combine(_folder, "_discovered"));
        File.WriteAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"), "vendors: [ this is : not : yaml");
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
        AddedHosts.Add(_folder, new AddHost("ours.example.test", AddedHosts.InternalKind, ["bb.ledger-worker"]));

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
        AddedHosts.Add(_folder, new AddHost("noise.example.test", AddedHosts.IgnoreKind, []));

        var links = RegistryLoader.LoadResilient(_folder).Environments.Single(e => e.Links is not null).Links!;

        Assert.Contains(@"^noise\.example\.test$", links.IgnoreHosts);
        Assert.Contains(@"^169\.254\.", links.IgnoreHosts); // the file's own patterns stay
        Assert.Matches(links.IgnoreHosts.Last(), "noise.example.test");
        Assert.DoesNotMatch(links.IgnoreHosts.Last(), "xnoise.example.test.evil");
    }

    // ---- rules for gateway paths ----

    [Theory]
    [InlineData("/frd/fraud-transaction-analysis/orchestrations/id/authorise", "^/frd/fraud-transaction-analysis(/|$)")]
    [InlineData("/aa/orders", "^/aa/orders(/|$)")]
    [InlineData("/aa", "^/aa(/|$)")]
    [InlineData("/", "^/")]
    public void A_rule_for_a_path_matches_its_first_two_parts(string path, string pattern) => Assert.Equal(pattern, AddedHosts.PathPattern(path));

    [Fact]
    public void A_rule_is_saved_with_the_gateway_host_the_wider_path_and_the_target_listed_and_removed_like_the_rest()
    {
        AddedHosts.AddRule(_folder, new AddRule("gw.a.example.test", "/aa/special/x/y", "aa.orders-api"));
        AddedHosts.AddRule(_folder, new AddRule("gw.a.example.test", "/aa/special/other", "aa.orders-api")); // the same rule again: once

        var text = File.ReadAllText(Path.Combine(_folder, "_discovered", "third-parties.yaml"));
        Assert.Contains("rules:", text);
        Assert.Contains("gateway: true", text);
        var rule = Assert.Single(AddedHosts.Read(_folder));
        Assert.Equal(AddedHosts.RuleKind, rule.Kind);
        Assert.Equal("aa.orders-api", rule.Name);
        Assert.Equal("^/aa/special(/|$)", rule.Host);
        Assert.True(AddedHosts.Remove(_folder, rule.Id));
        Assert.Empty(AddedHosts.Read(_folder));
    }

    [Fact]
    public void An_added_rule_is_tried_after_the_environments_own_and_explains_the_path()
    {
        AddedHosts.AddRule(_folder, new AddRule("gw.a.example.test", "/aa/special/x/y", "aa.orders-api"));

        var registry = RegistryLoader.LoadResilient(_folder);
        var links = registry.ForEnvironment("prod").ActiveEnvironment!.Links!;
        var classifier = new ObservabilityCity.Core.Links.LinkClassifier(links, registry.Vendors, registry.AllNodes.Select(n => n.Id), ObservabilityCity.Core.Links.LinkClassifier.ServicesOf(registry.AllNodes));

        Assert.True(links.Rules.Count >= 2);
        var added = links.Rules.Last();
        Assert.Equal("aa.orders-api", added.Target);
        Assert.True(added.Gateway);
        var found = classifier.Classify(new ObservabilityCity.Core.Links.DependencyRow("bb.ledger-api", "gw.a.example.test", "/aa/special/x/y", [new DateOnly(2026, 10, 29)], 5), "bb");
        Assert.Equal(new ObservabilityCity.Core.Links.Classified(ObservabilityCity.Core.Links.LinkOutcome.Found, "aa.orders-api", true), found);
        var other = classifier.Classify(new ObservabilityCity.Core.Links.DependencyRow("bb.ledger-api", "gw.a.example.test", "/zz/nothing", [new DateOnly(2026, 10, 29)], 5), "bb");
        Assert.Equal(ObservabilityCity.Core.Links.LinkOutcome.Unresolved, other.Outcome);
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
        Assert.Equal("ext.files-example-test", list[0].Id);
        Assert.Equal(["aa.orders-api"], list[0].CalledBy);
        Assert.Contains(towns.Default.Registry.Current.Vendors, v => v.Node.Id == "ext.files-example-test"); // loaded again at once
        Assert.DoesNotContain(Discovered(server).UnknownHosts(2), h => h.Host == "files.example.test");
        Assert.Single(await client.GetFromJsonAsync<List<AddedHostSnapshot>>("/api/added-hosts", Json) ?? []);

        var remove = await client.DeleteAsync("/api/added-hosts?id=ext.files-example-test");

        Assert.Equal(HttpStatusCode.OK, remove.StatusCode);
        Assert.Empty((await remove.Content.ReadFromJsonAsync<List<AddedHostSnapshot>>(Json))!);
        Assert.DoesNotContain(towns.Default.Registry.Current.Vendors, v => v.Node.Id == "ext.files-example-test");
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/added-hosts?id=ext.files-example-test")).StatusCode);
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

    [Fact]
    public async Task Adding_a_rule_for_a_gateway_path_saves_it_and_takes_that_path_off_the_unknown_list()
    {
        using var server = Server();
        var client = server.CreateClient();
        Discovered(server).RecordUnresolved("aa.orders-api", "gw.a.example.test", "/zz/special/x", Days, 100);
        Discovered(server).RecordUnresolved("aa.orders-api", "gw.a.example.test", "/yy/other/x", Days, 50);
        Discovered(server).Judge(_ => false, host => host == "gw.a.example.test");

        var ok = await client.PostAsJsonAsync("/api/added-rules", new AddRuleRequest("gw.a.example.test", "/zz/special/x", "bb.ledger-api"), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var list = (await ok.Content.ReadFromJsonAsync<List<AddedHostSnapshot>>(Json, TestContext.Current.CancellationToken))!;
        Assert.Equal("bb.ledger-api", Assert.Single(list).Name);
        var gw = Assert.Single(Discovered(server).UnknownHosts(2), h => h.Host == "gw.a.example.test");
        Assert.Equal(["/yy/other/x"], gw.Paths!.Select(p => p.Path).ToArray()); // the path the rule explains left, the other stayed
        Assert.Equal(HttpStatusCode.OK, (await client.DeleteAsync("/api/added-hosts?id=" + Uri.EscapeDataString(list[0].Id), TestContext.Current.CancellationToken)).StatusCode);
        Assert.Empty(AddedHosts.Read(_folder));
    }

    [Fact]
    public async Task A_rule_for_a_path_that_is_not_listed_a_plain_host_or_a_system_that_is_not_in_the_town_is_refused()
    {
        using var server = Server();
        var client = server.CreateClient();
        Discovered(server).RecordUnresolved("aa.orders-api", "gw.a.example.test", "/zz/special/x", Days, 100);
        Discovered(server).RecordUnresolved("aa.orders-api", "plain.example.test", "/v1", Days, 100);
        Discovered(server).Judge(_ => false, host => host == "gw.a.example.test");

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/added-rules", new AddRuleRequest("gw.a.example.test", "/never/seen/x", "bb.ledger-api"), TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/added-rules", new AddRuleRequest("plain.example.test", "/v1", "bb.ledger-api"), TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/added-rules", new AddRuleRequest("gw.a.example.test", "/zz/special/x", "no.such-api"), TestContext.Current.CancellationToken)).StatusCode);
        Assert.Empty(AddedHosts.Read(_folder));
    }
}
