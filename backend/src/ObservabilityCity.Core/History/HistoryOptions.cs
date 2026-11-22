namespace ObservabilityCity.Core.History;

/// <summary>
/// The settings of the history recorder (the <c>History</c> section of the host's configuration). History is for live towns only: a demo town has no past worth keeping.
/// </summary>
public sealed class HistoryOptions
{
    /// <summary>The most days the town can be taken back, and how long frames are kept (1 to 14).</summary>
    public const int MaxDays = 14;

    /// <summary>The shortest gap between two frames the setting allows, in seconds.</summary>
    public const int MinIntervalSeconds = 10;

    /// <summary>Turns recording and the time bar off for every town (default on).</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>How many days back the town can go (1 to 14, default 7).</summary>
    public int Days { get; set; } = 7;

    /// <summary>The gap between two recorded frames in seconds (default 300, five minutes). Frames sit on the clock: 10:00, 10:05, 10:10 for 300.</summary>
    public int IntervalSeconds { get; set; } = 300;

    /// <summary>Where history is kept. Empty means the town's own folder, in <c>_history/</c>; a path here holds one folder for each town.</summary>
    public string? Path { get; set; }

    /// <summary>The same settings for one environment, which may keep fewer or more days than the app's setting says (<c>history.days</c> in its file).</summary>
    public HistoryOptions ForDays(int? days) => new() { Enabled = Enabled, Days = days ?? Days, IntervalSeconds = IntervalSeconds, Path = Path };

    public int EffectiveDays => Math.Clamp(Days, 1, MaxDays);
    public TimeSpan Interval => TimeSpan.FromSeconds(Math.Max(IntervalSeconds, MinIntervalSeconds));
    public TimeSpan Keep => TimeSpan.FromDays(EffectiveDays);

    /// <summary>The folder that holds the history of one town.</summary>
    public string FolderFor(string townFolder, string townId) =>
        string.IsNullOrWhiteSpace(Path) ? System.IO.Path.Combine(townFolder, "_history") : System.IO.Path.Combine(Path, townId);
}
