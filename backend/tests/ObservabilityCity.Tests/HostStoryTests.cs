using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using ObservabilityCity.Contracts;

using ObservabilityCity.Host;

namespace ObservabilityCity.Tests;

/// <summary>The story and Break things endpoints of the running server (the mini town ships one story, orders-trouble).</summary>
public class HostStoryTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private readonly WebApplicationFactory<Program> _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:Path", TestPaths.MiniTown);
        b.UseSetting("Registry:WatchSeconds", "0");
        b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        b.UseSetting("Fake:PollInterval", "00:00:00.2");
    });

    private HttpClient Client => _factory.CreateClient();

    public void Dispose() => _factory.Dispose();

    private sealed record Story(string Id, string Name, double Duration, StoryStep[] Steps);
    private sealed record StoryStep(int Index, double At, string? Caption, string? Camera);
    private sealed record State(string? StoryId, bool Playing, bool Ended, double Speed, double Position, double Duration, int Step, string? Caption, string? Camera);

    private async Task<State> StoryState() => (await Client.GetFromJsonAsync<State>("/api/fake/story", Json))!;

    [Fact]
    public async Task The_stories_of_the_town_are_listed_with_their_steps()
    {
        var list = await Client.GetFromJsonAsync<Story[]>("/api/fake/stories", Json);

        var story = Assert.Single(list!);
        Assert.Equal("orders-trouble", story.Id);
        Assert.Equal("Orders trouble", story.Name);
        Assert.Equal(40, story.Duration);
        Assert.Equal([0, 10, 20, 30], story.Steps.Select(s => s.At));
        Assert.Equal("The orders API starts to fail.", story.Steps[1].Caption);
        Assert.Equal("aa.orders-api", story.Steps[1].Camera);
    }

    [Fact]
    public async Task Play_pause_resume_speed_seek_and_stop_move_the_player()
    {
        var client = Client;
        Assert.Null((await StoryState()).StoryId);

        var played = await client.PostAsJsonAsync("/api/fake/story/play", new { id = "orders-trouble", speed = 2 });
        Assert.Equal(HttpStatusCode.OK, played.StatusCode);
        var s = await StoryState();
        Assert.Equal("orders-trouble", s.StoryId);
        Assert.True(s.Playing);
        Assert.Equal(2, s.Speed);

        await client.PostAsync("/api/fake/story/pause", null);
        var paused = await StoryState();
        Assert.False(paused.Playing);
        await Task.Delay(300);
        Assert.Equal(paused.Position, (await StoryState()).Position);

        await client.PostAsJsonAsync("/api/fake/story/seek", new { seconds = 25 });
        var sought = await StoryState();
        Assert.Equal(25, sought.Position, 3);
        Assert.Equal(2, sought.Step);
        Assert.Equal("The orders worker goes down.", sought.Caption);

        await client.PostAsJsonAsync("/api/fake/story/speed", new { speed = 4 });
        Assert.Equal(4, (await StoryState()).Speed);

        await client.PostAsync("/api/fake/story/resume", null);
        Assert.True((await StoryState()).Playing);

        await client.PostAsync("/api/fake/story/stop", null);
        var stopped = await StoryState();
        Assert.Null(stopped.StoryId);
        Assert.False(stopped.Playing);
    }

    [Fact]
    public async Task An_unknown_story_or_environment_is_not_found()
    {
        var client = Client;

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/fake/story/play", new { id = "nope" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/fake/stories?env=nowhere")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/fake/story/pause?env=nowhere", null)).StatusCode);
    }

    [Fact]
    public async Task A_story_that_is_scrubbed_breaks_the_town_and_reset_puts_it_right()
    {
        var client = Client;
        await client.PostAsJsonAsync("/api/fake/calm", new { on = true });
        await client.PostAsJsonAsync("/api/fake/story/play", new { id = "orders-trouble" });
        await client.PostAsync("/api/fake/story/pause", null);
        await client.PostAsJsonAsync("/api/fake/story/seek", new { seconds = 25 });

        await Eventually(async () => (await Node("aa.orders-worker")).State == HealthState.Down);

        await client.PostAsync("/api/fake/reset", null);
        Assert.Null((await StoryState()).StoryId);
        await Eventually(async () => (await Node("aa.orders-worker")).State == HealthState.Healthy);
    }

    [Fact]
    public async Task Effects_set_by_hand_can_change_intensity_and_the_state_lists_hand_effects_the_story_and_the_day()
    {
        var client = Client;
        await client.PostAsync("/api/fake/reset", null);
        var created = await (await client.PostAsJsonAsync("/api/fake/effects", new { target = "aa.orders-api", kind = "Errors", intensity = 0.2 })).Content.ReadFromJsonAsync<JsonElement>(Json);
        var id = created.GetProperty("id").GetString();

        Assert.Equal(HttpStatusCode.NoContent, (await client.PutAsJsonAsync($"/api/fake/effects/{id}", new { intensity = 0.9 })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PutAsJsonAsync("/api/fake/effects/fx9999", new { intensity = 0.9 })).StatusCode);

        var state = await client.GetFromJsonAsync<JsonElement>("/api/fake", Json);
        Assert.Equal(0.9, state.GetProperty("effects")[0].GetProperty("intensity").GetDouble(), 3);
        Assert.Equal(120, state.GetProperty("dayLengthSeconds").GetDouble());
        Assert.Equal(JsonValueKind.Null, state.GetProperty("story").GetProperty("storyId").ValueKind);
        await client.PostAsync("/api/fake/reset", null);
    }

    [Fact]
    public async Task The_length_of_a_day_can_be_changed_but_not_below_five_seconds()
    {
        var client = Client;

        var ok = await client.PostAsJsonAsync("/api/fake/day", new { seconds = 30 });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(30, (await client.GetFromJsonAsync<JsonElement>("/api/fake", Json)).GetProperty("dayLengthSeconds").GetDouble());

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/fake/day", new { seconds = 1 })).StatusCode);
        await client.PostAsJsonAsync("/api/fake/day", new { seconds = 120 });
    }

    private async Task<NodeSnapshot> Node(string id)
    {
        var s = (await Client.GetFromJsonAsync<Snapshot>("/api/snapshot/latest", Json))!;
        return s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);
    }

    private static async Task Eventually(Func<Task<bool>> check)
    {
        for (var i = 0; i < 100; i++)
        {
            try { if (await check()) return; } catch (HttpRequestException) { }
            await Task.Delay(100);
        }
        Assert.True(await check(), "the town never reached the expected state");
    }
}
