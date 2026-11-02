using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slice 5: a consumer's drawer links to its dead letters in the team's support tool, when the environment says where that is
/// (<c>entities.deadLetterLink</c>). The program knows no tool: two towns write different addresses over different words and get their own links.
/// </summary>
public class DeadLetterLinkTests
{
    private static string Town(string name) => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", $"messaging-town-{name}");

    [Fact]
    public void A_consumer_links_to_its_dead_letters_with_the_codes_of_the_scope_rules()
    {
        var registry = RegistryLoader.Load(Town("a")).ForEnvironment("prod");

        var link = SystemDetails.Of(registry, "aa.orders-worker")!.DeadLetterLink!;

        Assert.Equal("Support tool", link.Name);
        Assert.Equal("https://support.example.test/queues?team=al&service=ord", link.Url); // the pillar's scope.code and the service's code, not the ids
    }

    [Fact]
    public void Another_town_names_another_tool_and_other_words()
    {
        var registry = RegistryLoader.Load(Town("b")).ForEnvironment("prod");

        var link = SystemDetails.Of(registry, "aa.orders-worker")!.DeadLetterLink!;

        Assert.Equal(("Parked messages", "https://parked.example.test/prod/aa.orders-worker"), (link.Name, link.Url));
    }

    [Theory]
    [InlineData("a", "aa.orders-api")]   // an API consumes nothing
    [InlineData("a", "aa.orders-db")]
    [InlineData("b", "aa.orders-api")]
    public void A_system_that_consumes_no_topic_has_no_link(string town, string id)
    {
        var registry = RegistryLoader.Load(Town(town)).ForEnvironment("prod");

        Assert.Null(SystemDetails.Of(registry, id)!.DeadLetterLink);
    }

    [Fact]
    public void An_environment_that_names_no_tool_gives_no_link()
    {
        var folder = Copy("a", yaml => System.Text.RegularExpressions.Regex.Replace(yaml, @"\s*deadLetterLink:[^\n]*\n", "\n"));
        try
        {
            var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
            Assert.Null(SystemDetails.Of(registry, "aa.orders-worker")!.DeadLetterLink);
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public void An_address_that_needs_a_word_the_system_has_none_of_gives_no_link_rather_than_a_broken_one()
    {
        // town B's systems have no service codes, so an address over {service} cannot be made for them; {pillar} falls back to the id
        var folder = Copy("b", yaml => yaml.Replace("https://parked.example.test/{environment}/{system}", "https://parked.example.test/{pillar}/{service}"));
        try
        {
            var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
            var link = SystemDetails.Of(registry, "aa.orders-worker")!.DeadLetterLink!;
            Assert.Equal("https://parked.example.test/aa/orders", link.Url); // the service name stands in for a code that is not there
        }
        finally { Directory.Delete(folder, true); }
    }

    [Theory]
    [InlineData("https://x.example.test/{queue}", "{queue} is not a variable of the url")]
    [InlineData("ftp://x.example.test/{system}", "url must start with http:// or https://")]
    [InlineData("", "url must start with http:// or https://")]
    public void An_address_that_cannot_work_is_refused_and_says_what_is_wrong(string url, string expected)
    {
        var folder = Copy("a", yaml => yaml.Replace("https://support.example.test/queues?team={pillar}&service={service}", url));
        try
        {
            var error = Assert.Throws<RegistryException>(() => RegistryLoader.Load(folder));
            Assert.Contains(expected, error.Message);
        }
        finally { Directory.Delete(folder, true); }
    }

    private static string Copy(string name, Func<string, string> env)
    {
        var target = Path.Combine(Path.GetTempPath(), "oc-dlq-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(Town(name), target);
        var file = Path.Combine(target, "environments", "prod.yaml");
        File.WriteAllText(file, env(File.ReadAllText(file)));
        return target;
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.GetDirectories(from)) CopyDirectory(d, Path.Combine(to, Path.GetFileName(d)));
    }
}
