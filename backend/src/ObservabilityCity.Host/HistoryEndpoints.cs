using System.Globalization;
using System.Text;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.History;

namespace ObservabilityCity.Host;

/// <summary>The endpoints that read the recorded history of one environment (<c>?town=</c> and <c>?env=</c> choose it, as everywhere).</summary>
public static class HistoryEndpoints
{
    /// <summary>The most frames one request returns, so a playback fetch stays small.</summary>
    public const int MaxFrames = 12;

    public static void Map(WebApplication app, HistoryOptions options)
    {
        // What is recorded: the range, and a point for each frame for the strip. A demo town, or history switched off, says so and nothing else.
        app.MapGet("/api/history/range", (EnvironmentSet envs, string? env, TimeProvider time) =>
            {
                if (envs.Find(env) is not { } rt) return NotFound(envs, env);
                if (rt.HistoryView is not { } store) return Results.Ok(new HistoryRange(false, options.EffectiveDays, (int)options.Interval.TotalSeconds, null, null, 0, 0, []));
                var since = time.GetUtcNow() - options.Keep;
                var summary = store.Summary(since);
                var points = store.Points(since).Select(p => new HistoryPointSnapshot(p.At, p.Unhealthy, p.Down, p.Rebuilt)).ToList();
                return Results.Ok(new HistoryRange(true, options.EffectiveDays, (int)options.Interval.TotalSeconds, summary.Oldest, summary.Newest, summary.Frames, summary.Bytes, points));
            })
           .Produces<HistoryRange>()
           .WithName("GetHistoryRange");

        // How the filling of the gaps stands, for the loading card. Priority asks for the hour of a time to be filled next. A town that cannot rebuild says it is not running.
        app.MapGet("/api/history/fill", (EnvironmentSet envs, string? env) =>
            {
                if (envs.Find(env) is not { } rt) return NotFound(envs, env);
                var status = rt.Filler?.Status;
                return Results.Ok(new HistoryFill(rt.Filler is not null, status?.Running ?? false, status?.Done ?? 0, status?.Total ?? 0, status?.Hour, status?.Problem));
            })
           .Produces<HistoryFill>()
           .WithName("GetHistoryFill");

        app.MapPost("/api/history/fill/priority", (EnvironmentSet envs, string? env, string? at) =>
            {
                if (envs.Find(env) is not { } rt) return NotFound(envs, env);
                if (!TryTime(at, out var when)) return Results.BadRequest(new { error = "at must be a time such as 2026-11-21T09:00:00Z." });
                rt.Filler?.Prioritise(when);
                return Results.Accepted();
            })
           .ExcludeFromDescription();

        // The frame at (or just before) a time: the snapshot as it was. 404 when nothing was recorded then.
        app.MapGet("/api/history/frame", (EnvironmentSet envs, string? env, string? at, TimeProvider time) =>
            {
                if (envs.Find(env) is not { } rt) return NotFound(envs, env);
                if (rt.HistoryView is not { } store) return Results.NotFound(new { error = "History is not kept for this environment." });
                if (!TryTime(at, out var when)) return Results.BadRequest(new { error = "at must be a time such as 2026-11-21T09:00:00Z." });
                if (when < time.GetUtcNow() - options.Keep) return Results.NotFound(new { error = $"History goes back {options.EffectiveDays} days." });
                return store.FrameAtOrBefore(when) is { } frame
                    ? Results.Content(Frame(frame.At, frame.Json, frame.Rebuilt), "application/json")
                    : Results.NotFound(new { error = "Nothing was recorded at that time." });
            })
           .ExcludeFromDescription();

        // Up to MaxFrames frames in a row from a time, for playback to read ahead: {"frames":[{"at":..,"snapshot":{..}}]}.
        app.MapGet("/api/history/frames", (EnvironmentSet envs, string? env, string? from, int? count) =>
            {
                if (envs.Find(env) is not { } rt) return NotFound(envs, env);
                if (rt.HistoryView is not { } store) return Results.NotFound(new { error = "History is not kept for this environment." });
                if (!TryTime(from, out var start)) return Results.BadRequest(new { error = "from must be a time such as 2026-11-21T09:00:00Z." });
                var frames = store.FramesFrom(start, Math.Clamp(count ?? MaxFrames, 1, MaxFrames));
                var text = new StringBuilder("{\"frames\":[");
                for (var i = 0; i < frames.Count; i++)
                {
                    if (i > 0) text.Append(',');
                    text.Append(Frame(frames[i].At, frames[i].Json, frames[i].Rebuilt));
                }
                return Results.Content(text.Append("]}").ToString(), "application/json");
            })
           .ExcludeFromDescription();
    }

    private static string Frame(DateTimeOffset at, string snapshot, bool rebuilt) =>
        $"{{\"at\":\"{at.ToString("O", CultureInfo.InvariantCulture)}\",\"rebuilt\":{(rebuilt ? "true" : "false")},\"snapshot\":{snapshot}}}";

    private static bool TryTime(string? text, out DateTimeOffset at) =>
        DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out at);

    private static IResult NotFound(EnvironmentSet envs, string? env) =>
        envs.Exists
            ? Results.NotFound(new { error = $"No environment '{env}'.", environments = envs.All.Select(e => e.Id) })
            : Results.NotFound(new { error = $"No town '{envs.TownId}'.", towns = Array.Empty<string>() });
}
