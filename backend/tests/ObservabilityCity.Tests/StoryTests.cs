using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>Stories: timelines of the Break things effects, played against the clock with play, pause, speed and scrub.</summary>
public class StoryTests
{
    private static Story Sample() => new()
    {
        Id = "s",
        Name = "Sample",
        Length = 40,
        Steps =
        [
            new StoryStep { At = 0, Caption = "Calm" },
            new StoryStep
            {
                At = 10, Caption = "Errors climb", Camera = "aa.orders-api",
                Ramp = [new StoryRampSpec { Target = "aa.orders-api", Kind = "Errors", From = 0, To = 1, Over = 10 }],
            },
            new StoryStep { At = 20, Caption = "Worker down", Apply = [new StoryEffectSpec { Target = "aa.orders-worker", Kind = "Down" }] },
            new StoryStep { At = 30, Clear = [new StoryClearSpec { Target = "aa.orders-api" }] },
        ],
    };

    [Fact]
    public void Before_the_first_step_nothing_is_in_force_and_there_is_no_caption()
    {
        var story = new Story { Id = "s", Steps = [new StoryStep { At = 5, Caption = "Later", Apply = [new StoryEffectSpec { Target = "*", Kind = "Traffic" }] }] };

        var m = story.At(2);

        Assert.Equal(-1, m.Step);
        Assert.Null(m.Caption);
        Assert.Empty(m.Effects);
    }

    [Fact]
    public void A_ramp_grows_from_its_start_to_its_end_and_then_holds()
    {
        var story = Sample();

        Assert.Equal(0, story.At(10).Effects.Single().Intensity, 6);
        Assert.Equal(0.5, story.At(15).Effects.Single().Intensity, 6);
        Assert.Equal(1, story.At(20).Effects.Single(e => e.Kind == FakeEffectKind.Errors).Intensity, 6);
        Assert.Equal(1, story.At(25).Effects.Single(e => e.Kind == FakeEffectKind.Errors).Intensity, 6);
    }

    [Fact]
    public void Apply_adds_effects_and_clear_takes_away_those_that_match()
    {
        var story = Sample();

        Assert.Equal(["aa.orders-api", "aa.orders-worker"], story.At(25).Effects.Select(e => e.Target).Order());
        Assert.Equal(["aa.orders-worker"], story.At(35).Effects.Select(e => e.Target));
    }

    [Fact]
    public void Clear_all_takes_everything_away_and_a_clear_by_kind_only_that_kind()
    {
        var story = new Story
        {
            Id = "s",
            Steps =
            [
                new StoryStep { At = 0, Apply = [new StoryEffectSpec { Target = "x", Kind = "Errors" }, new StoryEffectSpec { Target = "x", Kind = "Latency" }] },
                new StoryStep { At = 1, Clear = [new StoryClearSpec { Kind = "errors" }] },
                new StoryStep { At = 2, Clear = [new StoryClearSpec { All = true }] },
            ],
        };

        Assert.Equal([FakeEffectKind.Latency], story.At(1.5).Effects.Select(e => e.Kind));
        Assert.Empty(story.At(2).Effects);
    }

    [Fact]
    public void The_caption_stays_until_a_later_step_has_one_and_the_camera_is_that_of_the_latest_step()
    {
        var story = Sample();

        Assert.Equal("Errors climb", story.At(12).Caption);
        Assert.Equal("aa.orders-api", story.At(12).Camera);
        Assert.Equal("Worker down", story.At(35).Caption); // the step at 30 has none, so the last one stands
        Assert.Null(story.At(35).Camera);
        Assert.Equal(3, story.At(35).Step);
    }

    [Fact]
    public void The_state_at_a_second_depends_only_on_that_second_so_scrubbing_back_undoes_what_came_after()
    {
        var story = Sample();
        var forward = story.At(25).Effects.Select(e => (e.Target, e.Kind, e.Intensity)).ToList();

        _ = story.At(39);
        var back = story.At(25).Effects.Select(e => (e.Target, e.Kind, e.Intensity)).ToList();

        Assert.Equal(forward, back);
        Assert.Empty(story.At(5).Effects);
    }

    [Fact]
    public void A_story_without_a_length_ends_five_seconds_after_its_last_step_or_ramp()
    {
        var story = Sample();
        story.Length = null;

        Assert.Equal(35, story.Duration); // the last step is at 30
        story.Steps[1].Ramp[0].Over = 30; // ramp ends at 40
        Assert.Equal(45, story.Duration);
    }

    [Fact]
    public void Problems_are_found_before_a_story_can_play()
    {
        var bad = new Story
        {
            Id = "bad",
            Steps =
            [
                new StoryStep { At = 5, Apply = [new StoryEffectSpec { Target = "x", Kind = "Explode" }] },
                new StoryStep { At = 2, Ramp = [new StoryRampSpec { Target = "", Kind = "Errors", Over = 0 }] },
                new StoryStep { At = 9 },
            ],
        };

        var problems = string.Join("\n", bad.Problems());

        Assert.Contains("'Explode' is not an effect kind", problems);
        Assert.Contains("steps must be in time order", problems);
        Assert.Contains("a ramp needs 'over' above zero", problems);
        Assert.Contains("an effect needs a target", problems);
        Assert.Contains("step 3: it does nothing", problems);
        Assert.Empty(Sample().Problems());
    }

    // ---- the player ----

    private sealed class PlayerRig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 26, 8, 0, 0, TimeSpan.Zero));
        public readonly StoryPlayer Player;
        public PlayerRig() => Player = new StoryPlayer([Sample()], Clock);
        public void Wait(double seconds) => Clock.Advance(TimeSpan.FromSeconds(seconds));
    }

    [Fact]
    public void Nothing_plays_until_a_story_is_started()
    {
        var rig = new PlayerRig();

        var s = rig.Player.State();

        Assert.Null(s.StoryId);
        Assert.False(s.Playing);
        Assert.Empty(s.Effects);
        Assert.False(rig.Player.Play("nope"));
    }

    [Fact]
    public void A_story_advances_with_the_clock_and_pauses_and_resumes_where_it_was()
    {
        var rig = new PlayerRig();
        rig.Player.Play("s");
        rig.Wait(12);
        Assert.Equal(12, rig.Player.State().Position, 3);
        Assert.Equal("Errors climb", rig.Player.State().Caption);

        rig.Player.Pause();
        rig.Wait(30);
        var paused = rig.Player.State();
        Assert.False(paused.Playing);
        Assert.Equal(12, paused.Position, 3);

        rig.Player.Resume();
        rig.Wait(10);
        Assert.Equal(22, rig.Player.State().Position, 3);
        Assert.True(rig.Player.State().Playing);
    }

    [Fact]
    public void Speed_scales_time_and_a_change_of_speed_keeps_the_position()
    {
        var rig = new PlayerRig();
        rig.Player.Play("s", 2);
        rig.Wait(5);
        Assert.Equal(10, rig.Player.State().Position, 3);

        rig.Player.SetSpeed(4);
        Assert.Equal(10, rig.Player.State().Position, 3);
        rig.Wait(2);
        Assert.Equal(18, rig.Player.State().Position, 3);
        Assert.Equal(4, rig.Player.State().Speed);

        rig.Player.SetSpeed(3.2); // only the offered speeds exist
        Assert.Equal(4, rig.Player.State().Speed);
    }

    [Fact]
    public void Seeking_jumps_to_a_second_while_playing_or_paused_and_the_effects_follow()
    {
        var rig = new PlayerRig();
        rig.Player.Play("s");

        rig.Player.Seek(25);
        Assert.Equal(["aa.orders-api", "aa.orders-worker"], rig.Player.Effects().Select(e => e.Target).Order());
        rig.Wait(2);
        Assert.Equal(27, rig.Player.State().Position, 3);

        rig.Player.Pause();
        rig.Player.Seek(5);
        Assert.Empty(rig.Player.Effects());
        Assert.Equal(5, rig.Player.State().Position, 3);
        Assert.False(rig.Player.State().Playing);

        rig.Player.Seek(500); // past the end stops at the end
        Assert.Equal(40, rig.Player.State().Position, 3);
    }

    [Fact]
    public void At_the_end_it_reports_ended_and_resume_starts_again_from_the_beginning()
    {
        var rig = new PlayerRig();
        rig.Player.Play("s");

        rig.Wait(60);
        var end = rig.Player.State();
        Assert.True(end.Ended);
        Assert.False(end.Playing);
        Assert.Equal(40, end.Position, 3);

        rig.Player.Resume();
        var again = rig.Player.State();
        Assert.False(again.Ended);
        Assert.True(again.Playing);
        Assert.Equal(0, again.Position, 3);
    }

    [Fact]
    public void Stopping_takes_the_effects_away_and_forgets_the_story()
    {
        var rig = new PlayerRig();
        rig.Player.Play("s");
        rig.Player.Seek(25);
        Assert.NotEmpty(rig.Player.Effects());

        rig.Player.Stop();

        Assert.Null(rig.Player.State().StoryId);
        Assert.Empty(rig.Player.Effects());
    }

    // ---- files ----

    [Fact]
    public void Stories_are_read_from_the_stories_folder_and_a_bad_file_is_skipped_with_a_notice()
    {
        var dir = Directory.CreateTempSubdirectory("oc-stories-");
        try
        {
            var folder = dir.CreateSubdirectory(StoryFiles.FolderName).FullName;
            File.WriteAllText(Path.Combine(folder, "good.yaml"), "name: Good one\nsteps:\n  - at: 0\n    caption: Hi\n  - at: 3\n    apply:\n      - { target: '*', kind: Traffic, intensity: 0.5 }\n");
            File.WriteAllText(Path.Combine(folder, "broken.yaml"), "steps:\n  - at: 0\n    apply:\n      - { target: x, kind: Explode }\n");
            File.WriteAllText(Path.Combine(folder, "garbled.yaml"), "steps: [ {at: zero} ]\n");

            var (stories, notices) = StoryFiles.Load(dir.FullName);

            var story = Assert.Single(stories);
            Assert.Equal("good", story.Id); // from the file name when it has no id
            Assert.Equal("Good one", story.Name);
            Assert.Equal(2, notices.Count);
            Assert.Contains(notices, n => n.Contains("broken.yaml") && n.Contains("Explode"));
            Assert.Contains(notices, n => n.Contains("garbled.yaml"));
        }
        finally { dir.Delete(true); }
    }

    [Fact]
    public void A_registry_without_a_stories_folder_has_no_stories()
    {
        var (stories, notices) = StoryFiles.Load(TestPaths.LinksTown);

        Assert.Empty(stories);
        Assert.Empty(notices);
    }

    [Theory]
    [InlineData("galactic")]
    [InlineData("mini")]
    public void The_stories_that_ship_with_a_town_are_sound_and_aim_at_systems_that_exist(string town)
    {
        var path = town == "galactic" ? TestPaths.Registry : TestPaths.MiniTown;
        var registry = RegistryLoader.Load(path);
        var known = registry.AllNodes.Select(n => n.Id)
            .Concat(registry.Vendors.Select(v => v.Node.Id)).Concat(registry.Groups.Select(g => g.Id)).Append("*").ToHashSet();

        var (stories, notices) = StoryFiles.Load(path);

        Assert.Empty(notices);
        Assert.NotEmpty(stories);
        foreach (var story in stories)
        {
            var targets = story.Steps.SelectMany(s => s.Apply.Select(a => a.Target).Concat(s.Ramp.Select(r => r.Target)).Concat(s.Clear.Select(c => c.Target)).Concat([s.Camera]))
                .Where(t => t is not null).Select(t => t!.Split('#')[0]);
            Assert.All(targets, t => Assert.True(known.Contains(t), $"{story.Id}: '{t}' is not a system, island or vendor of the town"));
        }
    }

    // ---- on the generator ----

    private sealed class FakeRig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 26, 8, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry = RegistryLoader.Load(TestPaths.MiniTown);
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public FakeRig()
        {
            var (stories, _) = StoryFiles.Load(TestPaths.MiniTown);
            Fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), Clock, stories) { Calm = true };
            Builder = new SnapshotBuilder(Registry, State, Clock) { StaleAfter = TimeSpan.FromSeconds(3), IncidentSources = [Fake] };
        }

        public async Task<Snapshot> Run(int seconds)
        {
            Snapshot s = null!;
            for (var i = 0; i < seconds; i++)
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                State.Update(await Fake.PollAsync(Registry, default));
                s = Builder.Build();
            }
            return s;
        }

        public NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);
    }

    [Fact]
    public async Task A_playing_story_breaks_the_town_the_way_its_steps_say_and_the_town_heals_when_it_ends()
    {
        var rig = new FakeRig();
        Assert.Equal(HealthState.Healthy, rig.Node(await rig.Run(2), "aa.orders-worker").State);

        Assert.True(rig.Fake.Story.Play("orders-trouble"));
        var before = await rig.Run(5);
        Assert.Equal(HealthState.Healthy, rig.Node(before, "aa.orders-api").State);

        var mid = await rig.Run(18); // 23 seconds in: the API fails and the worker is down
        Assert.True(rig.Node(mid, "aa.orders-api").ErrorRate > 0.2);
        Assert.Equal(HealthState.Down, rig.Node(mid, "aa.orders-worker").State);

        var after = await rig.Run(12); // 35 seconds in: everything cleared
        Assert.Equal(HealthState.Healthy, rig.Node(after, "aa.orders-worker").State);
        Assert.True(rig.Node(after, "aa.orders-api").ErrorRate < 0.05);
        Assert.Empty(rig.Fake.Effects); // the story's effects were never put among the ones set by hand
    }

    [Fact]
    public async Task Effects_set_by_hand_and_a_story_work_together_and_reset_stops_both()
    {
        var rig = new FakeRig();
        rig.Fake.Add("bb.ledger-api", FakeEffectKind.Down, 1);
        rig.Fake.Story.Play("orders-trouble");
        var s = await rig.Run(25);
        Assert.Equal(HealthState.Down, rig.Node(s, "bb.ledger-api").State);
        Assert.Equal(HealthState.Down, rig.Node(s, "aa.orders-worker").State);

        rig.Fake.Reset();
        s = await rig.Run(8);

        Assert.Null(rig.Fake.Story.State().StoryId);
        Assert.Equal(HealthState.Healthy, rig.Node(s, "bb.ledger-api").State);
        Assert.Equal(HealthState.Healthy, rig.Node(s, "aa.orders-worker").State);
    }

    [Fact]
    public async Task Scrubbing_a_story_moves_the_town_to_that_second()
    {
        var rig = new FakeRig();
        rig.Fake.Story.Play("orders-trouble");
        rig.Fake.Story.Pause();

        rig.Fake.Story.Seek(25);
        var broken = await rig.Run(3);
        Assert.Equal(HealthState.Down, rig.Node(broken, "aa.orders-worker").State);

        rig.Fake.Story.Seek(2);
        var healed = await rig.Run(6);
        Assert.Equal(HealthState.Healthy, rig.Node(healed, "aa.orders-worker").State);
    }

    [Fact]
    public async Task A_story_incident_shows_over_the_island_with_its_severity()
    {
        var dir = Directory.CreateTempSubdirectory("oc-story-incident-");
        try
        {
            var story = new Story { Id = "storm", Steps = [new StoryStep { At = 0, Apply = [new StoryEffectSpec { Target = "aa", Kind = "Incident", Intensity = 0.9 }] }] };
            var rig = new FakeRig();
            var fake = new FakeSource(FakeProfiles.Load(TestPaths.MiniTown), new FakeOptions(), rig.Clock, [story]) { Calm = true };
            fake.Story.Play("storm");

            var incidents = fake.Current(rig.Registry);

            var i = Assert.Single(incidents);
            Assert.Equal("aa", i.GroupId);
            Assert.Equal(1, i.Severity);
            fake.Story.Stop();
            Assert.Empty(fake.Current(rig.Registry));
        }
        finally { dir.Delete(true); }
        await Task.CompletedTask;
    }

    [Fact]
    public async Task The_intensity_of_an_effect_set_by_hand_can_be_changed_and_the_town_follows()
    {
        var rig = new FakeRig();
        var fx = rig.Fake.Add("aa.orders-api", FakeEffectKind.Errors, 0.1);
        var low = rig.Node(await rig.Run(3), "aa.orders-api").ErrorRate;

        Assert.True(rig.Fake.SetIntensity(fx.Id, 1));
        var high = rig.Node(await rig.Run(3), "aa.orders-api").ErrorRate;

        Assert.True(high > low + 0.15);
        Assert.Equal(1, rig.Fake.Effects.Single().Intensity);
        Assert.True(rig.Fake.SetIntensity(fx.Id, 7)); // clamped like any intensity
        Assert.Equal(1, rig.Fake.Effects.Single().Intensity);
        Assert.False(rig.Fake.SetIntensity("fx999", 0.5));
    }
}
