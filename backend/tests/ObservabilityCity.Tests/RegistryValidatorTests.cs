using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>The checks that run in CI against every registry folder in the repo, beyond what loading a registry needs.</summary>
public class RegistryValidatorTests
{
    private static ValidationResult Check(RegistryCopy f) => RegistryValidator.Validate(f.Path);

    private static Finding Single(ValidationResult r, string rule) => Assert.Single(r.Findings, x => x.Rule == rule);

    [Theory]
    [InlineData("config/galactic-credit")]
    [InlineData("shared-test-data/registries/mini-town")]
    [InlineData("shared-test-data/registries/tenants-town")]
    [InlineData("shared-test-data/registries/stress-23")]
    [InlineData("shared-test-data/registries/stress-35")]
    public void Every_registry_in_the_repo_is_clean(string folder)
    {
        var r = RegistryValidator.Validate(Path.Combine(TestPaths.RepoRoot, folder));

        Assert.True(r.Findings.Count == 0, string.Join("\n", r.Findings.Select(f => $"{f.File}:{f.Line} [{f.Rule}] {f.Message}")));
    }

    [Fact]
    public void The_discovery_finds_every_registry_folder()
    {
        var found = Report.FindRegistries(TestPaths.RepoRoot).Select(p => Report.RelativePath(TestPaths.RepoRoot, p)).ToList();

        Assert.Contains("config/galactic-credit", found);
        Assert.Contains("shared-test-data/registries/mini-town", found);
        Assert.Contains("shared-test-data/registries/tenants-town", found);
        Assert.Contains("shared-test-data/registries/stress-23", found);
        Assert.Contains("shared-test-data/registries/stress-35", found);
    }

    [Fact]
    public void A_pillar_missing_from_the_layout_is_an_error_on_its_file()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("layout.yaml", "[aa, bb, cc]", "[aa, bb]");

        var hit = Single(Check(f), "layout");

        Assert.Equal(Severity.Error, hit.Severity);
        Assert.Equal("pillars/cc.yaml", hit.File);
        Assert.Contains("'cc'", hit.Message);
    }

    [Fact]
    public void Lost_and_found_needs_no_layout_entry()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Write("pillars/lost-found.yaml", "pillar: lost-found\ndisplayName: Lost & found\ncolor: \"#9aa3ad\"\nsystems:\n  - { id: lost-found.thing, name: Thing, role: api, external: true }\n");

        Assert.Empty(Check(f).Findings);
    }

    [Fact]
    public void A_missing_layout_file_is_only_a_warning()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        File.Delete(f.FilePath("layout.yaml"));

        var hit = Single(Check(f), "layout");

        Assert.Equal(Severity.Warning, hit.Severity);
    }

    [Fact]
    public void An_unknown_role_is_an_error_at_the_line_of_the_system()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/bb.yaml", "role: worker", "role: workr");

        var hit = Single(Check(f), "registry");

        Assert.Equal("pillars/bb.yaml", hit.File);
        Assert.Equal(f.LineOf("pillars/bb.yaml", "bb.ledger-worker"), hit.Line);
        Assert.Contains("worker", hit.Message); // the did-you-mean
    }

    [Fact]
    public void A_call_between_pillars_must_go_through_the_hub()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "calls: [aa.orders-db] }\n  - { id: aa.orders-worker", "calls: [aa.orders-db, bb.ledger-api] }\n  - { id: aa.orders-worker");

        var hit = Single(Check(f), "cross-pillar-call");

        Assert.Equal(Severity.Error, hit.Severity);
        Assert.Equal("pillars/aa.yaml", hit.File);
        Assert.Equal(f.LineOf("pillars/aa.yaml", "aa.orders-api"), hit.Line);
        Assert.Contains("hub", hit.Message);
    }

    [Fact]
    public void A_call_into_the_hub_is_fine_and_a_direct_town_may_call_across_pillars()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "calls: [aa.orders-db] }\n  - { id: aa.orders-worker", "calls: [aa.orders-db, hub.apim] }\n  - { id: aa.orders-worker");
        Assert.Empty(Check(f).Findings);

        f.Replace("pillars/aa.yaml", "hub.apim", "bb.ledger-api");
        Assert.Single(Check(f).Findings, x => x.Rule == "cross-pillar-call");
        f.Replace("town.yaml", "hub-and-spoke", "direct");
        Assert.Empty(Check(f).Findings);
    }

    [Fact]
    public void Outside_callers_may_only_reach_external_systems()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("hub.yaml", "calls: [aa.orders-api, bb.ledger-api]", "calls: [aa.orders-api, bb.ledger-db]");

        var hit = Assert.Single(Check(f).Findings);

        Assert.Equal("hub.yaml", hit.File);
        Assert.Equal(f.LineOf("hub.yaml", "mobile-app"), hit.Line);
        Assert.Contains("not marked external", hit.Message);
    }

    [Theory]
    [InlineData("errors: { amber: 0.2, red: 0.1 }", "must be below")]
    [InlineData("errors: { amber: 0, red: 0.1 }", "share between 0 and 1")]
    [InlineData("errors: { amber: 0.05, red: 5 }", "share between 0 and 1")]
    [InlineData("slaP99Ms: -5", "above 0")]
    [InlineData("backlog: { amber: 300, red: 60 }", "must be below")]
    [InlineData("throttle: { amber: 0.9, red: 0.5 }", "must be below")]
    [InlineData("resources: { amber: 0.95, red: 0.8 }", "must be below")]
    public void Silly_thresholds_are_errors_on_the_line_that_sets_them(string setting, string expected)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "role: api, external: true,", $"role: api, external: true, {setting},");

        var hit = Single(Check(f), "threshold");

        Assert.Equal(Severity.Error, hit.Severity);
        Assert.Equal("pillars/aa.yaml", hit.File);
        Assert.Equal(f.LineOf("pillars/aa.yaml", "aa.orders-api"), hit.Line);
        Assert.Contains(expected, hit.Message);
    }

    [Fact]
    public void A_bad_threshold_in_the_defaults_is_reported_once_there_not_on_every_system()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("defaults.yaml", "api:      { slaP99Ms: 1000, errors: { amber: 0.01, red: 0.05 } }", "api:      { slaP99Ms: 1000, errors: { amber: 0.5, red: 0.05 } }");

        var hit = Single(Check(f), "threshold");

        Assert.Equal("defaults.yaml", hit.File);
        Assert.Equal(f.LineOf("defaults.yaml", "api:"), hit.Line);
    }

    [Fact]
    public void A_system_override_that_meets_the_defaults_badly_is_caught()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        // red is left to the defaults (0.05), but the system's own amber is above it
        f.Replace("pillars/aa.yaml", "role: api, external: true,", "role: api, external: true, errors: { amber: 0.07 },");

        var hit = Single(Check(f), "threshold");

        Assert.Contains("after the defaults", hit.Message);
    }

    [Theory]
    [InlineData("#5aa9ff", false)]
    [InlineData("#fff", false)]
    [InlineData("blue", true)]
    [InlineData("5aa9ff", true)]
    [InlineData("#5aa9f", true)]
    [InlineData("#zzzzzz", true)]
    public void Colours_must_be_hex(string colour, bool bad)
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "color: \"#5aa9ff\"", $"color: \"{colour}\"");

        var hits = Check(f).Findings.Where(x => x.Rule == "colour").ToList();

        Assert.Equal(bad ? 1 : 0, hits.Count);
        if (bad) Assert.Equal(f.LineOf("pillars/aa.yaml", "color:"), hits[0].Line);
    }

    [Fact]
    public void Fake_data_must_name_real_systems()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("fake.yaml", "aa.orders-api:", "aa.order-api:");

        var hit = Single(Check(f), "fake");

        Assert.Equal("fake.yaml", hit.File);
        Assert.Equal(f.LineOf("fake.yaml", "aa.order-api"), hit.Line);
        Assert.Contains("aa.orders-api", hit.Message); // did you mean
    }

    [Fact]
    public void Fake_numbers_must_make_sense()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.ReplaceLine("fake.yaml", "aa.orders-api:", "aa.orders-api: { rps: -1, p99Ms: 120, minInstances: 5, maxInstances: 3, errorRate: 4, perInstanceRps: 0 }");

        var hits = Check(f).Findings.Where(x => x.Rule == "fake").Select(x => x.Message).ToList();

        Assert.Contains(hits, m => m.Contains("rps must be a number"));
        Assert.Contains(hits, m => m.Contains("minInstances (5) is above maxInstances (3)"));
        Assert.Contains(hits, m => m.Contains("errorRate"));
        Assert.Contains(hits, m => m.Contains("perInstanceRps must be above 0"));
    }

    [Fact]
    public void A_misspelt_fake_field_is_reported_with_its_line()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.ReplaceLine("fake.yaml", "aa.orders-api:", "aa.orders-api: { rpss: 40 }");

        var hit = Single(Check(f), "fake");

        Assert.Equal("fake.yaml", hit.File);
        Assert.Equal(Severity.Error, hit.Severity);
    }

    [Fact]
    public void A_worker_without_a_database_is_a_warning()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/cc.yaml", "{ id: cc.notify-worker, service: notify, name: Notify worker, role: worker, calls: [cc.notify-db] }", "{ id: cc.notify-worker, name: Notify worker, role: worker }");

        var hit = Single(Check(f), "worker-db");

        Assert.Equal(Severity.Warning, hit.Severity);
        Assert.Equal(f.LineOf("pillars/cc.yaml", "cc.notify-worker"), hit.Line);
    }

    [Fact]
    public void A_system_nobody_calls_is_a_warning_and_does_not_fail_the_run()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/bb.yaml", "role: db }", "role: db }\n  - { id: bb.orphan-cache, name: Orphan, role: cache }");

        var r = Check(f);
        var hit = Single(r, "uncalled");

        Assert.Equal(Severity.Warning, hit.Severity);
        Assert.Equal(0, r.Errors);
        Assert.Equal(1, r.Warnings);
        Assert.Equal(f.LineOf("pillars/bb.yaml", "bb.orphan-cache"), hit.Line);
    }

    [Fact]
    public void The_hub_has_room_for_one_gateway_broker_egress_and_database()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("hub.yaml", "resources:\n", "resources:\n  - { id: hub.second-gateway, name: Another gateway, role: gateway }\n  - { id: hub.web, name: Web, role: api }\n");

        var hits = Check(f).Findings.Where(x => x.Rule == "hub").ToList();

        Assert.Equal(2, hits.Count);
        Assert.All(hits, h => Assert.Equal("hub.yaml", h.File));
    }

    [Fact]
    public void A_town_too_big_for_its_ring_capacity_is_an_error_that_names_the_fix()
    {
        using var f = new RegistryCopy(TestPaths.Stress23);
        f.Write("pillars/p24.yaml", "pillar: p24\ndisplayName: One more\ncolor: \"#5aa9ff\"\nsystems:\n  - { id: p24.api, name: API, role: api, external: true }\n");
        f.Replace("layout.yaml", "p23]", "p23, p24]");

        var r = Check(f);

        Assert.True(r.Errors > 0);
        Assert.Contains(r.Findings, x => x.Message.Contains("24 pillars do not fit on two rings of 12: at most 23") && x.Message.Contains("ringCapacity to 13 or more"));
    }

    [Fact]
    public void An_unreadable_hub_file_is_reported_not_thrown()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Write("hub.yaml", "resources: [oops\n");

        var r = Check(f);

        Assert.Equal(1, r.Errors);
        Assert.Equal("hub.yaml", r.Findings[0].File);
    }

    [Fact]
    public void Several_broken_pillars_are_all_reported()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "role: worker", "role: wurker");
        f.Replace("pillars/bb.yaml", "role: worker", "role: wurker");
        f.Write("pillars/cc.yaml", "pillar: cc\nsystems: [broken\n");

        var files = Check(f).Findings.Where(x => x.Severity == Severity.Error).Select(x => x.File).Distinct().Order().ToList();

        Assert.Equal(["pillars/aa.yaml", "pillars/bb.yaml", "pillars/cc.yaml"], files);
    }

    [Fact]
    public void The_report_formats_name_file_and_line()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "role: worker", "role: wurker");
        var r = Check(f);

        using var text = new StringWriter();
        Report.WriteAnnotations(r, f.Path, text);
        var markdown = Report.Markdown([r], f.Path);

        Assert.Contains("::error file=pillars/aa.yaml,line=", text.ToString());
        Assert.StartsWith(Report.CommentMarker, markdown);
        Assert.Contains("pillars/aa.yaml:", markdown);
        Assert.Contains("problems to fix", markdown);
    }

    // ── services, environments, tenants ──────────────────────────────────────

    [Fact]
    public void A_service_split_across_pillars_is_a_warning_on_each_pillars_file()
    {
        using var f = new RegistryCopy(TestPaths.TenantsTown);
        f.Replace("pillars/bb.yaml", "service: billing, name: Billing API", "service: orders, name: Billing API");

        var hits = Check(f).Findings.Where(x => x.Rule == "service-split").ToList();

        Assert.Equal(["pillars/aa.yaml", "pillars/bb.yaml"], hits.Select(h => h.File).Order());
        Assert.All(hits, h => Assert.Equal(Severity.Warning, h.Severity));
        Assert.All(hits, h => Assert.Contains("Service 'orders' is split across pillars 'aa' and 'bb'", h.Message));
        Assert.Equal(f.LineOf("pillars/bb.yaml", "bb.billing-api"), hits.Single(h => h.File == "pillars/bb.yaml").Line);
    }

    [Fact]
    public void Systems_of_one_service_that_are_not_next_to_each_other_are_fine()
    {
        using var f = new RegistryCopy(TestPaths.TenantsTown); // aa.orders-api and aa.orders-worker have a cache between them

        Assert.DoesNotContain(Check(f).Findings, x => x.Rule == "service-split");
    }

    [Fact]
    public void A_mistake_in_an_environment_file_is_an_error_on_that_file_and_line()
    {
        using var f = new RegistryCopy(TestPaths.TenantsTown);
        f.Replace("environments/prod.yaml", "{ id: cygnus, name: Cygnus, kind: customer }", "{ id: cygnus, name: Cygnus, kind: customerr }");

        var hit = Assert.Single(Check(f).Findings, x => x.File == "environments/prod.yaml");

        Assert.Equal(Severity.Error, hit.Severity);
        Assert.Contains("kind 'customerr'", hit.Message);
    }

    [Fact]
    public void An_environment_with_tenant_databases_and_no_tenants_is_a_warning_on_its_file()
    {
        using var f = new RegistryCopy(TestPaths.TenantsTown);
        f.Write("environments/prod.yaml", "default: true\n");

        var hit = Single(Check(f), "tenants");

        Assert.Equal(Severity.Warning, hit.Severity);
        Assert.Equal("environments/prod.yaml", hit.File);
        Assert.Contains("lists no tenants", hit.Message);
    }

    [Fact]
    public void A_tenant_pattern_in_a_town_without_environments_is_a_warning_on_the_system()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("pillars/aa.yaml", "{ id: aa.orders-db,", "{ id: aa.orders-db, tenantPattern: \"t-{tenant}\",");

        var hit = Single(Check(f), "tenants");

        Assert.Equal(Severity.Warning, hit.Severity);
        Assert.Equal("pillars/aa.yaml", hit.File);
        Assert.Contains("no environments folder", hit.Message);
    }
}
