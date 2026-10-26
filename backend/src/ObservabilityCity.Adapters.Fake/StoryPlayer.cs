namespace ObservabilityCity.Adapters.Fake;

/// <summary>Where the player is, for the story bar.</summary>
public sealed record StoryState(
    string? StoryId, bool Playing, bool Ended, double Speed, double Position, double Duration,
    int Step, string? Caption, string? Camera, IReadOnlyList<StoryEffect> Effects);

/// <summary>
/// Plays one story at a time against the clock: play, pause, speed, scrub. Its effects are layered on the generator beside the ones
/// set by hand, and go away when the story stops. Position is worked out from the clock when asked, so nothing needs to tick.
/// </summary>
public sealed class StoryPlayer(IReadOnlyList<Story> library, TimeProvider clock)
{
    public static readonly double[] Speeds = [0.5, 1, 2, 4, 8];

    private readonly object _gate = new();
    private Story? _story;
    private bool _playing;
    private double _speed = 1;
    private double _basePosition;
    private DateTimeOffset _baseTime;

    public IReadOnlyList<Story> Library { get; } = library;

    /// <summary>Starts a story from the beginning, replacing the one playing. Returns false when there is no such story.</summary>
    public bool Play(string id, double? speed = null)
    {
        var story = Library.FirstOrDefault(s => s.Id == id);
        if (story is null) return false;
        lock (_gate)
        {
            _story = story;
            _speed = speed is { } s ? Snap(s) : _speed;
            _basePosition = 0;
            _baseTime = clock.GetUtcNow();
            _playing = true;
        }
        return true;
    }

    public void Pause()
    {
        lock (_gate)
        {
            if (_story is null || !_playing) return;
            _basePosition = PositionLocked();
            _playing = false;
        }
    }

    /// <summary>Carries on from where it paused; a story that has ended starts again from the beginning.</summary>
    public void Resume()
    {
        lock (_gate)
        {
            if (_story is null) return;
            var ended = PositionLocked() >= _story.Duration - 1e-9;
            if (_playing && !ended) return;
            _basePosition = ended ? 0 : PositionLocked();
            _baseTime = clock.GetUtcNow();
            _playing = true;
        }
    }

    /// <summary>Jumps to a second of the story, playing or paused. The effects are those of that second, whatever came before.</summary>
    public void Seek(double seconds)
    {
        lock (_gate)
        {
            if (_story is null) return;
            _basePosition = Math.Clamp(seconds, 0, _story.Duration);
            _baseTime = clock.GetUtcNow();
        }
    }

    public void SetSpeed(double speed)
    {
        lock (_gate)
        {
            _basePosition = PositionLocked();
            _baseTime = clock.GetUtcNow();
            _speed = Snap(speed);
        }
    }

    /// <summary>Stops the story and takes its effects away.</summary>
    public void Stop()
    {
        lock (_gate)
        {
            _story = null;
            _playing = false;
            _basePosition = 0;
        }
    }

    public StoryState State()
    {
        lock (_gate)
        {
            if (_story is null) return new StoryState(null, false, false, _speed, 0, 0, -1, null, null, []);
            var position = PositionLocked();
            var ended = position >= _story.Duration - 1e-9;
            var moment = _story.At(position);
            return new StoryState(_story.Id, _playing && !ended, ended, _speed, position, _story.Duration, moment.Step, moment.Caption, moment.Camera, moment.Effects);
        }
    }

    /// <summary>The effects the story has in force now.</summary>
    public IReadOnlyList<StoryEffect> Effects() => State().Effects;

    private double PositionLocked()
    {
        if (_story is null) return 0;
        var position = _playing ? _basePosition + (clock.GetUtcNow() - _baseTime).TotalSeconds * _speed : _basePosition;
        return Math.Clamp(position, 0, _story.Duration);
    }

    private static double Snap(double speed) => Speeds.MinBy(s => Math.Abs(s - speed));
}
