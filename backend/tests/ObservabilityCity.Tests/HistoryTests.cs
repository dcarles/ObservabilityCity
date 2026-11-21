using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.History;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Host;

namespace ObservabilityCity.Tests;

/// <summary>
/// The history of a live town: frames saved as plain files (one gzip file for each hour, a whole snapshot first and only the changes after), a small index for the
/// time bar, a cleaner for the limit, and the recorder that saves a frame on the clock. Proven with real snapshots of the mini town.
/// </summary>
public sealed class HistoryTests : IDisposable
{
    private static readonly TimeSpan Gap = TimeSpan.FromMinutes(5);
    private static readonly DateTimeOffset T0 = new(2026, 11, 21, 10, 0, 0, TimeSpan.Zero);
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "history-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_folder, true); } catch (IOException) { }
    }

    private FileHistoryStore Store() => new(_folder, Gap);

    private static JsonNode Frame(int degraded, int down = 0, double requests = 10) => JsonNode.Parse($$"""
        {"townId":"t","totals":{"requestsPerSecond":{{requests}},"degraded":{{degraded}},"down":{{down}}},"groups":[{"id":"a","nodes":[1,2,3]}],"note":null}
        """)!;

    private static async Task<Snapshot> RealSnapshot(int seconds = 3)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var registry = RegistryLoader.Load(TestPaths.MiniTown);
        var state = new LatestState();
        var fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), clock) { Calm = true };
        var builder = new SnapshotBuilder(registry, state, clock) { StaleAfter = TimeSpan.FromSeconds(3), IncidentSources = [fake] };
        for (var i = 0; i < seconds; i++)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            state.Update(await fake.PollAsync(registry, default));
        }
        return builder.Build();
    }

    // ---- the changes between two snapshots

    [Fact]
    public void A_patch_rebuilds_the_next_snapshot_from_the_one_before()
    {
        var before = JsonNode.Parse("""{"a":1,"b":{"c":2,"d":[1,2]},"gone":true,"n":null,"l":[{"x":1},{"x":2}]}""")!;
        var after = JsonNode.Parse("""{"a":2,"b":{"c":2,"d":[1,2,3],"e":"new"},"n":5,"l":[{"x":1},{"x":9}]}""")!;

        var ops = SnapshotPatch.Diff(before, after);
        var rebuilt = SnapshotPatch.Apply(before, ops);

        Assert.True(JsonNode.DeepEquals(after, rebuilt));
        Assert.Equal("""{"a":1,"b":{"c":2,"d":[1,2]},"gone":true,"n":null,"l":[{"x":1},{"x":2}]}""", before.ToJsonString());
        Assert.DoesNotContain("\"x\":1", ops.ToJsonString()); // a list of the same length is compared position by position, so only the item that moved is written // the snapshot given is not changed
        Assert.Empty(SnapshotPatch.Diff(after, after.DeepClone()));
    }

    // ---- the store

    [Fact]
    public void Frames_come_back_exactly_as_they_were_saved_and_a_time_gets_the_frame_at_or_before_it()
    {
        var store = Store();
        var frames = new[] { Frame(0), Frame(3, 1, 42), Frame(3, 1, 43) };
        for (var i = 0; i < frames.Length; i++) store.Append(T0 + i * Gap, frames[i], 0, 0);

        for (var i = 0; i < frames.Length; i++)
        {
            var found = store.FrameAtOrBefore(T0 + i * Gap + TimeSpan.FromMinutes(2));
            Assert.NotNull(found);
            Assert.Equal(T0 + i * Gap, found.Value.At);
            Assert.True(JsonNode.DeepEquals(frames[i], JsonNode.Parse(found.Value.Json)));
        }
        Assert.Null(store.FrameAtOrBefore(T0 - TimeSpan.FromMinutes(1))); // before the first frame
    }

    [Fact]
    public void A_time_more_than_two_gaps_after_the_last_frame_has_no_data()
    {
        var store = Store();
        store.Append(T0, Frame(0), 0, 0);

        Assert.NotNull(store.FrameAtOrBefore(T0 + Gap * 2));
        Assert.Null(store.FrameAtOrBefore(T0 + Gap * 2 + TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void A_frame_just_after_the_hour_turns_is_found_from_the_hour_before()
    {
        var store = Store();
        store.Append(new DateTimeOffset(2026, 11, 21, 10, 55, 0, TimeSpan.Zero), Frame(2), 0, 0);

        var found = store.FrameAtOrBefore(new DateTimeOffset(2026, 11, 21, 11, 1, 0, TimeSpan.Zero));
        Assert.NotNull(found);
        Assert.Equal(10, found.Value.At.Hour);
    }

    [Fact]
    public void Only_the_first_frame_of_an_hour_is_whole_and_a_new_hour_starts_again_with_a_whole_one()
    {
        var store = Store();
        Assert.True(store.Append(T0, Frame(0), 0, 0));
        Assert.False(store.Append(T0 + Gap, Frame(1), 1, 0));
        Assert.True(store.Append(T0 + TimeSpan.FromHours(1), Frame(2), 2, 0));

        var hourOne = Path.Combine(_folder, "recorded", "2026-11-21", "10.jsonl.gz");
        var lines = ReadLines(hourOne);
        Assert.Equal(2, lines.Count);
        Assert.NotNull(lines[0]["f"]);
        Assert.Null(lines[1]["f"]);
        Assert.NotNull(lines[1]["p"]);
        Assert.NotNull(ReadLines(Path.Combine(_folder, "recorded", "2026-11-21", "11.jsonl.gz"))[0]["f"]);
    }

    [Fact]
    public void A_restart_in_the_middle_of_an_hour_carries_on_in_the_same_file()
    {
        var first = Store();
        first.Append(T0, Frame(0), 0, 0);
        first.Append(T0 + Gap, Frame(1), 1, 0);

        var second = Store(); // the server started again
        second.Append(T0 + Gap * 3, Frame(4, 2), 6, 2);

        Assert.Equal(3, ReadLines(Path.Combine(_folder, "recorded", "2026-11-21", "10.jsonl.gz")).Count);
        Assert.True(JsonNode.DeepEquals(Frame(1), JsonNode.Parse(second.FrameAtOrBefore(T0 + Gap)!.Value.Json)));
        Assert.True(JsonNode.DeepEquals(Frame(4, 2), JsonNode.Parse(second.FrameAtOrBefore(T0 + Gap * 3)!.Value.Json)));
    }

    [Fact]
    public void A_frame_cut_off_by_a_crash_loses_only_that_frame()
    {
        var store = Store();
        store.Append(T0, Frame(0), 0, 0);
        store.Append(T0 + Gap, Frame(1), 1, 0);
        var file = Path.Combine(_folder, "recorded", "2026-11-21", "10.jsonl.gz");
        using (var stream = new FileStream(file, FileMode.Append)) stream.Write([0x1f, 0x8b, 0x08, 0x00, 0x01]); // the start of a member that never finished

        var found = Store().FrameAtOrBefore(T0 + Gap);
        Assert.NotNull(found);
        Assert.Equal(T0 + Gap, found.Value.At);
    }

    // ---- the index

    [Fact]
    public void The_index_lists_every_frame_with_its_counts_and_is_rebuilt_from_the_hour_files_when_it_is_lost()
    {
        var store = Store();
        store.Append(T0, Frame(0), 0, 0);
        store.Append(T0 + Gap, Frame(3, 1), 4, 1);
        store.Append(T0 + Gap * 2, Frame(2), 2, 0);

        var points = store.Points(T0 - TimeSpan.FromDays(1));
        Assert.Equal([0, 4, 2], points.Select(p => p.Unhealthy));
        Assert.Equal([0, 1, 0], points.Select(p => p.Down));

        Directory.Delete(Path.Combine(_folder, "index"), true);
        var rebuilt = Store().Points(T0 - TimeSpan.FromDays(1));
        Assert.Equal(points.Select(p => p.At), rebuilt.Select(p => p.At));
        Assert.Equal([0, 4, 2], rebuilt.Select(p => p.Unhealthy)); // read again from each frame's own totals (degraded and down together)
    }

    [Fact]
    public void A_damaged_line_in_the_index_is_left_out_and_the_rest_is_used()
    {
        var store = Store();
        store.Append(T0, Frame(1), 1, 0);
        File.AppendAllText(Path.Combine(_folder, "index", "2026-11-21.jsonl"), "{not json\n");
        store.Append(T0 + Gap, Frame(2), 2, 0);

        Assert.Equal(2, store.Points(T0 - TimeSpan.FromHours(1)).Count);
    }

    // ---- the cleaner

    [Fact]
    public void The_cleaner_deletes_whole_hours_and_days_older_than_the_limit_and_never_the_hour_being_written()
    {
        var store = Store();
        var now = new DateTimeOffset(2026, 11, 21, 10, 30, 0, TimeSpan.Zero);
        foreach (var at in new[] { now - TimeSpan.FromDays(9), now - TimeSpan.FromDays(8) - TimeSpan.FromHours(3), now - TimeSpan.FromDays(7) + TimeSpan.FromHours(2), now })
            store.Append(at, Frame(1), 1, 0);

        var removed = store.Prune(now - TimeSpan.FromDays(7));

        Assert.Equal(2, removed);
        Assert.False(Directory.Exists(Path.Combine(_folder, "recorded", "2026-11-12")));
        Assert.True(File.Exists(Path.Combine(_folder, "recorded", "2026-11-21", "10.jsonl.gz")));
        Assert.Equal(2, store.Points(now - TimeSpan.FromDays(7)).Count);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(_folder, "index")).Length); // the two days before the limit are gone, the others stay
    }

    // ---- the recorder

    [Fact]
    public void Frames_are_saved_on_the_clock_and_the_next_slot_is_the_next_multiple_of_the_gap()
    {
        Assert.Equal(new DateTimeOffset(2026, 11, 21, 10, 5, 0, TimeSpan.Zero), HistoryRecorder.NextSlot(new DateTimeOffset(2026, 11, 21, 10, 3, 27, TimeSpan.Zero), Gap));
        Assert.Equal(new DateTimeOffset(2026, 11, 21, 10, 5, 0, TimeSpan.Zero), HistoryRecorder.NextSlot(new DateTimeOffset(2026, 11, 21, 10, 0, 0, TimeSpan.Zero), Gap));
    }

    [Fact]
    public async Task The_recorder_saves_a_frame_at_each_slot_while_someone_looks_and_none_while_nobody_does()
    {
        var clock = new FakeTimeProvider(T0 + TimeSpan.FromMinutes(1));
        var latest = new SnapshotStore();
        latest.Set(await RealSnapshot());
        var demand = new Demand(TimeSpan.Zero, clock);
        var recorder = new HistoryRecorder(Store(), latest, new HistoryOptions { IntervalSeconds = 300 }, demand, clock);
        await recorder.StartAsync(TestContext.Current.CancellationToken);
        await Task.Delay(200, TestContext.Current.CancellationToken);

        clock.Advance(TimeSpan.FromMinutes(4)); // 10:05: nobody looks
        await Task.Delay(200, TestContext.Current.CancellationToken);
        Assert.Empty(Store().Points(T0 - TimeSpan.FromHours(1)));

        demand.Join();
        clock.Advance(Gap); // 10:10
        await WaitFor(() => Store().Points(T0 - TimeSpan.FromHours(1)).Count == 1);
        clock.Advance(Gap); // 10:15
        await WaitFor(() => Store().Points(T0 - TimeSpan.FromHours(1)).Count == 2);

        Assert.Equal([T0 + Gap * 2, T0 + Gap * 3], Store().Points(T0 - TimeSpan.FromHours(1)).Select(p => p.At));
        await recorder.StopAsync(TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task A_recorded_snapshot_is_the_snapshot_the_browser_gets_and_later_frames_are_far_smaller_than_the_first()
    {
        var snapshot = await RealSnapshot();
        var store = Store();
        var json = HistoryRecorder.ToJson(snapshot);
        store.Append(T0, json, 0, 0);
        var changed = await RealSnapshot(5);
        store.Append(T0 + Gap, HistoryRecorder.ToJson(changed), 0, 0);

        var back = store.FrameAtOrBefore(T0 + Gap)!.Value;
        Assert.True(JsonNode.DeepEquals(HistoryRecorder.ToJson(changed), JsonNode.Parse(back.Json)));
        var hour = ReadLines(Path.Combine(_folder, "recorded", "2026-11-21", "10.jsonl.gz"));
        Assert.True(hour[1].ToJsonString().Length < hour[0].ToJsonString().Length / 2, $"the change record is {hour[1].ToJsonString().Length} characters, the whole snapshot {hour[0].ToJsonString().Length}");
        Assert.Equal(snapshot.Totals.Degraded + snapshot.Totals.Down, FileHistoryStore.Counts(json).Unhealthy);
    }

    // ---- the options

    [Fact]
    public void The_limit_stays_between_one_and_fourteen_days_and_the_gap_is_never_below_ten_seconds()
    {
        Assert.Equal(14, new HistoryOptions { Days = 90 }.EffectiveDays);
        Assert.Equal(1, new HistoryOptions { Days = 0 }.EffectiveDays);
        Assert.Equal(TimeSpan.FromSeconds(10), new HistoryOptions { IntervalSeconds = 1 }.Interval);
        Assert.Equal(Path.Combine("town", "_history"), new HistoryOptions().FolderFor("town", "x"));
        Assert.Equal(Path.Combine("kept", "x"), new HistoryOptions { Path = "kept" }.FolderFor("town", "x"));
    }

    // ---- the endpoints

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private WebApplicationFactory<Program> Host(string town, bool enabled = true) => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:Path", town);
        b.UseSetting("Registry:WatchSeconds", "0");
        b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        b.UseSetting("Fake:PollInterval", "00:00:00.2");
        b.UseSetting("History:Path", _folder);
        b.UseSetting("History:Enabled", enabled ? "true" : "false");
    });

    [Fact]
    public async Task A_demo_town_and_a_town_with_history_off_say_history_is_not_kept()
    {
        foreach (var (town, enabled) in new[] { (TestPaths.TenantsTown, true), (TestPaths.LiveTown, false) })
        {
            using var factory = Host(town, enabled);
            var range = await factory.CreateClient().GetFromJsonAsync<HistoryRange>("/api/history/range", Json, TestContext.Current.CancellationToken);
            Assert.NotNull(range);
            Assert.False(range.Enabled);
            Assert.Empty(range.Points);
            Assert.Equal(HttpStatusCode.NotFound, (await factory.CreateClient().GetAsync("/api/history/frame?at=2026-11-21T10:00:00Z", TestContext.Current.CancellationToken)).StatusCode);
        }
    }

    [Fact]
    public async Task A_live_town_serves_its_range_a_frame_and_frames_in_a_row_and_refuses_what_it_does_not_have()
    {
        using var factory = Host(TestPaths.LiveTown);
        var store = factory.Services.GetRequiredService<TownSet>().Default.Environments.Default.History!;
        var now = DateTimeOffset.UtcNow;
        var slot = new DateTimeOffset((now.UtcTicks / Gap.Ticks - 1) * Gap.Ticks, TimeSpan.Zero);
        for (var i = 0; i < 3; i++) store.Append(slot - Gap * (2 - i), Frame(i, 0, 10 + i), i, 0);
        var client = factory.CreateClient();
        var ct = TestContext.Current.CancellationToken;

        var range = (await client.GetFromJsonAsync<HistoryRange>("/api/history/range", Json, ct))!;
        Assert.True(range.Enabled);
        Assert.Equal(7, range.Days);
        Assert.Equal(300, range.IntervalSeconds);
        Assert.Equal(3, range.Frames);
        Assert.Equal(slot, range.Newest);
        Assert.Equal([0, 1, 2], range.Points.Select(p => p.Unhealthy));
        Assert.True(range.Bytes > 0);

        var one = JsonNode.Parse(await client.GetStringAsync($"/api/history/frame?at={Uri.EscapeDataString((slot - Gap).ToString("O"))}", ct))!;
        Assert.Equal(1, (int)one["snapshot"]!["totals"]!["degraded"]!);

        var rows = JsonNode.Parse(await client.GetStringAsync($"/api/history/frames?from={Uri.EscapeDataString((slot - Gap * 2).ToString("O"))}&count=2", ct))!["frames"]!.AsArray();
        Assert.Equal(2, rows.Count);
        Assert.Equal(10, (int)rows[0]!["snapshot"]!["totals"]!["requestsPerSecond"]!);
        Assert.Equal(11, (int)rows[1]!["snapshot"]!["totals"]!["requestsPerSecond"]!);

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/history/frame?at=2026-01-01T00:00:00Z", ct)).StatusCode); // older than the limit
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/history/frame?at={Uri.EscapeDataString((slot + TimeSpan.FromHours(3)).ToString("O"))}", ct)).StatusCode); // no data then
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/history/frame?at=soon", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/history/range?env=nope", ct)).StatusCode);
    }

    // ---- helpers

    private static async Task WaitFor(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(50);
        Assert.True(condition(), "the condition did not become true in time");
    }

    private static List<JsonObject> ReadLines(string file)
    {
        using var stream = File.OpenRead(file);
        using var gzip = new System.IO.Compression.GZipStream(stream, System.IO.Compression.CompressionMode.Decompress);
        using var reader = new StreamReader(gzip);
        var lines = new List<JsonObject>();
        while (reader.ReadLine() is { Length: > 0 } text) lines.Add((JsonObject)JsonNode.Parse(text)!);
        return lines;
    }
}
