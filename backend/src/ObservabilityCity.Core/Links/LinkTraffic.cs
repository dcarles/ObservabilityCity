using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Links;

/// <summary>
/// How an environment measures who calls an API (<c>links.traffic</c>). <see cref="Query"/> is a template of the same kind as the discovery query
/// (see <see cref="LinkQuery"/>) that returns one row for each caller and address over the window, with the columns <c>caller</c>, <c>host</c>, <c>calls</c>
/// (sampling-corrected) and, for a gateway, <c>path</c>; <c>days</c> is not needed. Below <see cref="MinCalls"/> observed calls to an API the share is
/// too noisy to trust and the last good one stands, marked as estimated.
/// </summary>
public sealed record LinkTrafficConfig(string Query, TimeSpan ShareWindow, int MinCalls, TimeSpan Interval)
{
    public static readonly TimeSpan DefaultShareWindow = TimeSpan.FromHours(1);
    public static readonly TimeSpan DefaultInterval = TimeSpan.FromMinutes(5);
    public const int DefaultMinCalls = 20;
}

/// <summary>Where one API's inbound traffic comes from: what town systems send it, and the rest, which is outside.</summary>
/// <param name="Outside">Requests per second nobody in the town explains. Never below zero.</param>
/// <param name="Callers">Requests per second from each town system, scaled down together if they would add up to more than the API receives.</param>
/// <param name="Estimated">The share stands on too few calls and is the last good one (or what little there is), not a fresh measurement.</param>
public sealed record InboundSplit(double Outside, IReadOnlyList<InboundLinkSnapshot> Callers, bool Estimated);

/// <summary>
/// What the traffic query last said about each call between town systems. The API's own total comes from the unsampled server metrics; the callers'
/// part comes from the sampled dependency table, corrected for sampling. The outside traffic is the difference: whatever the town does not
/// explain. A caller is only known when it is a town system whose own calls the query sees, so everything else is outside.
/// </summary>
public sealed class LinkTraffic
{
    private readonly object _gate = new();
    private readonly Dictionary<string, Dictionary<string, double>> _calls = []; // target to caller to calls in the window
    private readonly Dictionary<string, Dictionary<string, double>> _lastGood = []; // target to caller to the share of the target's rate
    private readonly Dictionary<string, List<(DateTimeOffset At, double Total)>> _totals = []; // target to its own rate, one sample for each half minute, over the window
    private readonly Dictionary<string, double> _seeds = []; // target to its rate averaged over the share window, read once at the start
    private static readonly TimeSpan SampleEvery = TimeSpan.FromSeconds(30);
    /// <summary>How much history the mean needs before it is trusted. Until then the current rate stands, as before.</summary>
    private static readonly TimeSpan MinHistory = TimeSpan.FromMinutes(10);
    private TimeSpan _window = LinkTrafficConfig.DefaultShareWindow;
    private int _minCalls = LinkTrafficConfig.DefaultMinCalls;
    private bool _read;
    private string? _error;

    /// <summary>True once a read has succeeded. Until then nothing is known about who calls what, and the snapshot says nothing about outside traffic.</summary>
    public bool Measured { get { lock (_gate) return _read; } }

    /// <summary>Why the last read failed, or null.</summary>
    public string? Error { get { lock (_gate) return _error; } }

    /// <summary>Replaces what is known with a fresh read. <paramref name="calls"/> holds the estimated calls from each caller to each target over <paramref name="window"/>.</summary>
    public void Update(IEnumerable<(string Caller, string Target, double Calls)> calls, TimeSpan window, int minCalls)
    {
        var next = new Dictionary<string, Dictionary<string, double>>();
        foreach (var (caller, target, n) in calls)
        {
            if (n <= 0) continue;
            var mine = next.TryGetValue(target, out var m) ? m : next[target] = [];
            mine[caller] = mine.GetValueOrDefault(caller) + n;
        }
        lock (_gate)
        {
            _calls.Clear();
            foreach (var (target, callers) in next) _calls[target] = callers;
            (_window, _minCalls, _read, _error) = (window, minCalls, true, null);
        }
    }

    /// <summary>
    /// Gives each API the rate it averaged over the share window before the town started watching, so the split is steady from the first minute. It stands
    /// in for the town's own history until that has ten minutes, then the history takes over.
    /// </summary>
    public void Seed(IReadOnlyDictionary<string, double> averages)
    {
        lock (_gate)
            foreach (var (target, rate) in averages)
                if (rate >= 0 && double.IsFinite(rate)) _seeds[target] = rate;
    }

    /// <summary>True once <see cref="Seed"/> has been given the averages.</summary>
    public bool Seeded { get { lock (_gate) return _seeds.Count > 0; } }

    public void Fail(string error)
    {
        lock (_gate) _error = error;
    }

    /// <summary>
    /// Splits <paramref name="total"/> (the API's measured requests per second) between the town systems that call it and the outside. Null until a read has
    /// succeeded: unmeasured is not the same as nobody calls.
    /// </summary>
    public InboundSplit? Split(string target, double total, DateTimeOffset? at = null)
    {
        lock (_gate)
        {
            if (!_read) return null;
            var basis = Smoothed(target, total, at);
            var seen = _calls.GetValueOrDefault(target) ?? [];
            var observed = seen.Values.Sum();
            var estimated = false;
            Dictionary<string, double> shares; // caller to its share of the API's rate
            if (observed > 0 && observed < _minCalls && _lastGood.TryGetValue(target, out var kept))
            {
                shares = kept;
                estimated = true;
            }
            else
            {
                var rates = seen.ToDictionary(kv => kv.Key, kv => kv.Value / _window.TotalSeconds);
                shares = basis > 0 ? rates.ToDictionary(kv => kv.Key, kv => kv.Value / basis) : [];
                estimated = observed > 0 && observed < _minCalls;
                if (!estimated && basis > 0) _lastGood[target] = Scaled(shares);
            }
            var scaled = Scaled(shares);
            var callers = scaled.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => new InboundLinkSnapshot(kv.Key, kv.Value * total)).ToList();
            return new InboundSplit(Math.Max(0, total * (1 - scaled.Values.Sum())), callers, estimated);
        }
    }

    /// <summary>
    /// The rate the callers' share is worked out against: the API's own rate averaged over the same window the callers' calls were counted in. The current
    /// rate alone covers a few minutes and, for a service with few calls, jumps about, which made a steady gateway look like outside traffic whenever a busy
    /// few minutes came along. Before enough history it is the average read at the start (see <see cref="Seed"/>), else the current rate; without a clock, the current rate.
    /// </summary>
    private double Smoothed(string target, double total, DateTimeOffset? at)
    {
        if (at is not { } now) return total;
        if (!_totals.TryGetValue(target, out var samples)) _totals[target] = samples = [];
        if (samples.Count == 0 || now - samples[^1].At >= SampleEvery) samples.Add((now, total));
        else samples[^1] = (samples[^1].At, total);
        samples.RemoveAll(x => x.At < now - _window);
        if (now - samples[0].At < MinHistory) return _seeds.TryGetValue(target, out var seed) ? seed : total;
        return samples.Average(x => x.Total);
    }

    /// <summary>The shares, scaled down together when the callers would add up to more than the API receives (the two are measured differently).</summary>
    private static Dictionary<string, double> Scaled(Dictionary<string, double> shares)
    {
        var sum = shares.Values.Sum();
        return sum > 1 ? shares.ToDictionary(kv => kv.Key, kv => kv.Value / sum) : new Dictionary<string, double>(shares);
    }
}
