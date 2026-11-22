using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.History;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>Slice 2: the gaps of the history are filled from what the cloud can say about the past, hour by hour, into a store of their own that never replaces a recorded frame.</summary>
public class HistoryRebuildTests : IDisposable
{
    private static string Town => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "oc-rebuild-" + Guid.NewGuid().ToString("N"));
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2025-12-30T12:30:00Z"));

    public void Dispose() { try { Directory.Delete(_folder, true); } catch (IOException) { } }

    private sealed class Stub(Func<DateTimeOffset, IReadOnlyDictionary<string, NodeReading>> at) : IPastMetricSource
    {
        public int Asked;
        public string Name => "telemetry";
        public TimeSpan PollInterval => TimeSpan.FromSeconds(30);
        public bool CanReadPast => true;
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => throw new NotSupportedException();
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAtAsync(TownRegistry registry, DateTimeOffset when, CancellationToken ct) { Asked++; return Task.FromResult(at(when)); }
    }

    private static NodeReading Reading(DateTimeOffset at, double rps) => new(at, true, 0, 0, 0, rps, 0.001, 50);

    private (HistoryRebuilder Rebuilder, FileHistoryStore Recorded, FileHistoryStore Rebuilt, Stub Source, PastFrameBuilder Frames) Setup(Func<DateTimeOffset, IReadOnlyDictionary<string, NodeReading>>? at = null)
    {
        var registry = RegistryLoader.Load(Town).ForEnvironment("prod");
        var live = new SnapshotBuilder(registry, new LatestState(), _time) { Environment = "prod" };
        var source = new Stub(at ?? (t => new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(t, t.Hour) }));
        var frames = new PastFrameBuilder(live, new LatestState(), new RegistryHolder(registry), [source]);
        var recorded = new FileHistoryStore(Path.Combine(_folder, "recorded-store"), Interval);
        var rebuilt = new FileHistoryStore(Path.Combine(_folder, "rebuilt-store"), Interval);
        return (new HistoryRebuilder(recorded, rebuilt, frames, Interval, _time), recorded, rebuilt, source, frames);
    }

    private static async Task Record(PastFrameBuilder frames, FileHistoryStore store, DateTimeOffset at)
    {
        var json = HistoryRecorder.ToJson(await frames.BuildAsync(at, CancellationToken.None));
        var (unhealthy, down) = FileHistoryStore.Counts(json);
        store.Append(at, json, unhealthy, down);
    }

    private sealed class Slow : IPastMetricSource
    {
        public int Now, Most;
        public string Name => "telemetry";
        public TimeSpan PollInterval => TimeSpan.FromSeconds(30);
        public bool CanReadPast => true;
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => throw new NotSupportedException();
        public async Task<IReadOnlyDictionary<string, NodeReading>> PollAtAsync(TownRegistry registry, DateTimeOffset when, CancellationToken ct)
        {
            var now = Interlocked.Increment(ref Now);
            lock (this) Most = Math.Max(Most, now);
            await Task.Delay(30, ct);
            Interlocked.Decrement(ref Now);
            return new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(when, when.Minute) };
        }
    }

    [Fact]
    public async Task By_default_the_frames_of_an_hour_are_built_one_after_the_other()
    {
        var registry = RegistryLoader.Load(Town).ForEnvironment("prod");
        var slow = new Slow();
        var frames = new PastFrameBuilder(new SnapshotBuilder(registry, new LatestState(), _time) { Environment = "prod" }, new LatestState(), new RegistryHolder(registry), [slow]);
        var rebuilder = new HistoryRebuilder(new FileHistoryStore(Path.Combine(_folder, "recorded-serial"), Interval), new FileHistoryStore(Path.Combine(_folder, "rebuilt-serial"), Interval), frames, Interval, _time);

        await rebuilder.RebuildHourAsync(DateTimeOffset.Parse("2025-12-30T09:00:00Z"), CancellationToken.None);

        Assert.Equal(1, slow.Most); // three at once made Azure Monitor slow down on a real environment
    }

    [Fact]
    public async Task The_frames_of_an_hour_can_be_built_a_few_at_a_time_and_are_saved_in_order()
    {
        var registry = RegistryLoader.Load(Town).ForEnvironment("prod");
        var slow = new Slow();
        var frames = new PastFrameBuilder(new SnapshotBuilder(registry, new LatestState(), _time) { Environment = "prod" }, new LatestState(), new RegistryHolder(registry), [slow]);
        var rebuilt = new FileHistoryStore(Path.Combine(_folder, "rebuilt-parallel"), Interval);
        var rebuilder = new HistoryRebuilder(new FileHistoryStore(Path.Combine(_folder, "recorded-parallel"), Interval), rebuilt, frames, Interval, _time, framesAtOnce: 3);

        var saved = await rebuilder.RebuildHourAsync(DateTimeOffset.Parse("2025-12-30T09:00:00Z"), CancellationToken.None);

        Assert.Equal(12, saved);
        Assert.Equal(3, slow.Most); // several at once, never more than the limit
        var points = rebuilt.Points(DateTimeOffset.Parse("2025-12-30T09:00:00Z")).Select(p => p.At).Where(t => t.Hour == 9).ToList();
        Assert.Equal(points.OrderBy(t => t).ToList(), points); // saved oldest first, however they finished
    }

    [Fact]
    public async Task The_hours_with_a_gap_are_listed_newest_first_and_the_hour_being_lived_is_left_out()
    {
        var (rebuilder, recorded, _, _, frames) = Setup();
        foreach (var slot in rebuilder.Slots(DateTimeOffset.Parse("2025-12-30T09:00:00Z"), DateTimeOffset.Parse("2025-12-30T10:00:00Z"))) await Record(frames, recorded, slot);

        var missing = rebuilder.MissingHours(DateTimeOffset.Parse("2025-12-30T09:00:00Z"));

        Assert.Equal([DateTimeOffset.Parse("2025-12-30T11:00:00Z"), DateTimeOffset.Parse("2025-12-30T10:00:00Z")], missing); // 09 is whole; 12 is now
    }

    [Fact]
    public async Task An_hour_is_built_and_saved_in_its_own_store_and_is_a_gap_no_more()
    {
        var (rebuilder, recorded, rebuilt, source, _) = Setup();
        var ten = DateTimeOffset.Parse("2025-12-30T10:00:00Z");

        var saved = await rebuilder.RebuildHourAsync(ten, CancellationToken.None);

        Assert.Equal(12, saved);
        Assert.Equal(12, source.Asked);
        Assert.Equal(12, rebuilt.Points(ten).Count);
        Assert.Empty(recorded.Points(ten)); // the recorded store is not touched
        var frame = rebuilt.FrameAtOrBefore(DateTimeOffset.Parse("2025-12-30T10:32:00Z"));
        Assert.Equal(DateTimeOffset.Parse("2025-12-30T10:30:00Z"), frame!.Value.At);
        Assert.Contains("\"requestsPerSecond\":10", frame.Value.Json); // the source's number for then
        Assert.DoesNotContain(ten, rebuilder.MissingHours(ten));
    }

    [Fact]
    public async Task Only_the_missing_slots_of_a_partly_recorded_hour_are_built()
    {
        var (rebuilder, recorded, rebuilt, source, frames) = Setup();
        foreach (var slot in rebuilder.Slots(DateTimeOffset.Parse("2025-12-30T09:00:00Z"), DateTimeOffset.Parse("2025-12-30T09:30:00Z"))) await Record(frames, recorded, slot);
        var asked = source.Asked;

        var saved = await rebuilder.RebuildHourAsync(DateTimeOffset.Parse("2025-12-30T09:00:00Z"), CancellationToken.None);

        Assert.Equal(6, saved); // 09:30 to 09:55
        Assert.Equal(6, source.Asked - asked);
        Assert.Equal(DateTimeOffset.Parse("2025-12-30T09:30:00Z"), rebuilt.Points(DateTimeOffset.Parse("2025-12-30T09:00:00Z")).Min(p => p.At));
    }

    [Fact]
    public async Task An_hour_whose_frame_fails_saves_nothing_and_stays_a_gap()
    {
        var calls = 0;
        var (rebuilder, _, rebuilt, _, _) = Setup(t => ++calls == 7 ? throw new HttpRequestException("429") : new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(t, 1) });
        var ten = DateTimeOffset.Parse("2025-12-30T10:00:00Z");

        await Assert.ThrowsAsync<HttpRequestException>(() => rebuilder.RebuildHourAsync(ten, CancellationToken.None));

        Assert.Empty(rebuilt.Points(ten));
        Assert.Contains(ten, rebuilder.MissingHours(ten));
    }

    [Fact]
    public async Task Recorded_and_rebuilt_frames_read_as_one_history_with_the_recorded_one_winning_and_each_saying_where_it_came_from()
    {
        var (rebuilder, recorded, rebuilt, _, frames) = Setup();
        var nine = DateTimeOffset.Parse("2025-12-30T09:00:00Z");
        foreach (var slot in rebuilder.Slots(nine, nine.AddMinutes(30))) await Record(frames, recorded, slot);
        await rebuilder.RebuildHourAsync(nine, CancellationToken.None); // 09:30 to 09:55 only
        var reader = new HistoryReader(recorded, rebuilt);

        var points = reader.Points(nine);
        var play = reader.FramesFrom(DateTimeOffset.Parse("2025-12-30T09:20:00Z"), 4);

        Assert.Equal(12, points.Count);
        Assert.All(points.Where(p => p.At < nine.AddMinutes(30)), p => Assert.False(p.Rebuilt));
        Assert.All(points.Where(p => p.At >= nine.AddMinutes(30)), p => Assert.True(p.Rebuilt));
        Assert.Equal([false, false, true, true], play.Select(f => f.Rebuilt)); // 09:20, 09:25, 09:30, 09:35
        Assert.False(reader.FrameAtOrBefore(DateTimeOffset.Parse("2025-12-30T09:27:00Z"))!.Value.Rebuilt);
        Assert.True(reader.FrameAtOrBefore(DateTimeOffset.Parse("2025-12-30T09:42:00Z"))!.Value.Rebuilt);
        Assert.Equal(12, reader.Summary(nine).Frames);
        Assert.Null(new HistoryReader(recorded, null).FrameAtOrBefore(DateTimeOffset.Parse("2025-12-30T09:50:00Z"))); // without the rebuilt store the gap is a gap
    }

    private HistoryFiller Filler(HistoryRebuilder rebuilder, Stub source, Demand? gate) =>
        new(rebuilder, [source], new HistoryOptions { Days = 1 }, gate, _time);

    [Fact]
    public async Task A_pass_fills_every_gap_of_the_days_kept_newest_first_and_a_second_pass_finds_nothing_to_do()
    {
        var (rebuilder, _, rebuilt, source, _) = Setup();
        var filler = Filler(rebuilder, source, gate: null);

        await filler.PassAsync(CancellationToken.None);

        Assert.False(filler.Status.Running);
        Assert.Null(filler.Status.Problem);
        Assert.True(filler.Status.Done >= 23);
        Assert.Empty(rebuilder.MissingHours(DateTimeOffset.Parse("2025-12-29T12:30:00Z")));
        var before = rebuilt.Points(DateTimeOffset.Parse("2025-12-29T00:00:00Z")).Count;
        await filler.PassAsync(CancellationToken.None);
        Assert.Equal(before, rebuilt.Points(DateTimeOffset.Parse("2025-12-29T00:00:00Z")).Count);
    }

    [Fact]
    public async Task An_hour_a_person_asks_for_goes_first()
    {
        var order = new List<DateTimeOffset>();
        var (rebuilder, _, _, source, _) = Setup(t => { order.Add(t); return new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(t, 1) }; });
        var filler = Filler(rebuilder, source, gate: null);

        filler.Prioritise(DateTimeOffset.Parse("2025-12-29T15:20:00Z"));
        await filler.PassAsync(CancellationToken.None);

        Assert.Equal(DateTimeOffset.Parse("2025-12-29T15:00:00Z"), order[0]); // not the newest hour
        Assert.Equal(DateTimeOffset.Parse("2025-12-30T11:00:00Z"), order[12]); // then the newest hour
    }

    [Fact]
    public async Task Nothing_is_fetched_when_nobody_looks_and_a_failed_hour_is_tried_again_only_after_ten_minutes()
    {
        var failing = true;
        var (rebuilder, _, rebuilt, source, _) = Setup(t => failing ? throw new HttpRequestException("login expired") : new Dictionary<string, NodeReading> { ["aa.orders-api"] = Reading(t, 1) });
        var nobody = new Demand();
        await Filler(rebuilder, source, nobody).PassAsync(CancellationToken.None);
        Assert.Equal(0, source.Asked); // nobody is looking

        var viewers = new Demand();
        viewers.Join();
        var filler = Filler(rebuilder, source, viewers);
        await filler.PassAsync(CancellationToken.None);
        Assert.Contains("login expired", filler.Status.Problem);
        Assert.Empty(rebuilt.Points(DateTimeOffset.Parse("2025-12-29T00:00:00Z")));
        var asked = source.Asked;

        failing = false;
        await filler.PassAsync(CancellationToken.None);
        Assert.Equal(asked, source.Asked); // left alone for now

        _time.Advance(TimeSpan.FromMinutes(11));
        await filler.PassAsync(CancellationToken.None);
        Assert.NotEmpty(rebuilt.Points(DateTimeOffset.Parse("2025-12-29T00:00:00Z")));
    }
}
