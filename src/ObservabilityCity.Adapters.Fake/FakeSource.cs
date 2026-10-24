using System.Collections.Concurrent;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Adapters.Fake;

public sealed class FakeOptions
{
    /// <summary>Real seconds that one simulated day takes.</summary>
    public double DayLengthSeconds { get; set; } = 120;
    public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(1);
}

/// <summary>
/// Generates a healthy, gently noisy town with a daily traffic cycle and autoscaling, then layers
/// scenario effects on top. It answers for every node, so it can stand in for unwired systems later.
/// </summary>
public sealed class FakeSource(
    IReadOnlyDictionary<string, FakeProfile> profiles,
    FakeOptions options,
    TimeProvider clock) : IMetricSource, IFakeControl
{
    // The autoscaler aims for this share of capacity, so nominal load sits mid-way and spikes push it over.
    private const double TargetUtilisation = 0.65;

    private readonly DateTimeOffset _start = clock.GetUtcNow();
    private readonly ConcurrentDictionary<string, int> _instances = new();
    private readonly object _gate = new();
    private readonly List<FakeEffect> _effects = [];
    private int _nextId;

    public string Name => "fake";
    public TimeSpan PollInterval => options.PollInterval;

    public bool Calm { get; set; }

    public IReadOnlyList<FakeEffect> Effects
    {
        get { lock (_gate) return _effects.ToList(); }
    }

    public FakeEffect Add(string target, FakeEffectKind kind, double intensity)
    {
        var e = new FakeEffect($"fx{Interlocked.Increment(ref _nextId)}", target, kind, Math.Clamp(intensity, 0, 1));
        lock (_gate) _effects.Add(e);
        return e;
    }

    public bool Remove(string id)
    {
        lock (_gate) return _effects.RemoveAll(e => e.Id == id) > 0;
    }

    public void Clear()
    {
        lock (_gate) _effects.Clear();
    }

    /// <summary>Position in the simulated day, 0 to 1. Frozen while Calm.</summary>
    public double DayFraction
    {
        get
        {
            if (Calm) return 0.5;
            var elapsed = (clock.GetUtcNow() - _start).TotalSeconds;
            return (elapsed / options.DayLengthSeconds + 0.3) % 1.0;
        }
    }

    public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry registry, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var t = (now - _start).TotalSeconds;
        var effects = Effects;
        var result = new Dictionary<string, NodeReading>();

        foreach (var node in registry.AllNodes)
        {
            var p = FakeProfiles.Fill(profiles.GetValueOrDefault(node.Id), node.Kind);
            var fx = effects.Where(e => Applies(e, node)).ToList();

            // Daily cycle: quiet at night, busy mid-afternoon.
            var cycle = Calm ? 0.8 : 0.55 + 0.45 * (0.5 - 0.5 * Math.Cos(2 * Math.PI * (DayFraction - 0.2)));
            var noise = Calm ? 1.0 : 1 + 0.07 * Wobble(node.Id, t, 11) + 0.03 * Wobble(node.Id, t, 3.1);

            var trafficFx = fx.Where(e => e.Kind == FakeEffectKind.Traffic).Sum(e => 4 * e.Intensity);
            var down = fx.Any(e => e.Kind == FakeEffectKind.Down);
            var rps = down ? 0 : p.Rps!.Value * cycle * noise * (1 + trafficFx);

            // Autoscale one step per poll toward what the load needs.
            var isStore = node.Kind == NodeKind.Database;
            var wanted = isStore ? p.MinInstances!.Value : (int)Math.Clamp(Math.Ceiling(rps / (p.PerInstanceRps!.Value * TargetUtilisation)), p.MinInstances!.Value, p.MaxInstances!.Value);
            var current = _instances.GetOrAdd(node.Id, _ => Math.Max(wanted, p.MinInstances.Value));
            if (!Calm) current += Math.Sign(wanted - current);
            else current = Math.Max(p.MinInstances.Value, (int)Math.Ceiling(p.Rps!.Value * 0.8 / (p.PerInstanceRps!.Value * TargetUtilisation)));
            _instances[node.Id] = current;

            var unhealthyShare = down ? 1.0 : Math.Clamp(fx.Where(e => e.Kind == FakeEffectKind.UnhealthyInstances).Sum(e => e.Intensity), 0, 1);
            var unhealthy = (int)Math.Ceiling(current * unhealthyShare - 1e-9);
            var healthy = Math.Max(0, current - unhealthy);

            var errorFx = fx.Where(e => e.Kind == FakeEffectKind.Errors).Select(e => 0.03 + 0.30 * e.Intensity).DefaultIfEmpty(0).Max();
            var errors = Math.Clamp(p.ErrorRate!.Value * (Calm ? 1 : 1 + 0.4 * Wobble(node.Id, t, 7)) + errorFx, 0, 1);

            var latencyFx = fx.Where(e => e.Kind == FakeEffectKind.Latency).Sum(e => 9 * e.Intensity);
            // Latency rises a little when instances are saturated, and with load on a degraded fleet.
            var saturation = healthy > 0 ? Math.Min(2.0, rps / (healthy * p.PerInstanceRps.Value)) : 2.0;
            var p99 = p.P99Ms!.Value * (1 + latencyFx) * (0.9 + 0.2 * saturation) * (Calm ? 1 : 1 + 0.05 * Wobble(node.Id, t, 5));

            double? cpu = null, memory = null, utilisation = null, throttled = null;
            double load = down ? 0 : saturation;
            if (!down && isStore)
            {
                // A data store is provisioned for a ceiling, so what matters is how much of it is used and what gets turned away.
                var provisioned = p.Rps!.Value * 1.6;
                var saturate = fx.Where(e => e.Kind == FakeEffectKind.Saturate).Sum(e => 0.6 * e.Intensity);
                utilisation = Math.Clamp(rps / provisioned + saturate, 0, 1.2);
                throttled = utilisation > 0.95 ? Math.Min(0.6, (utilisation.Value - 0.95) * 2.4) : 0;
                load = utilisation.Value;
                errors = Math.Clamp(errors + throttled.Value * 0.2, 0, 1);
            }
            else if (!down)
            {
                var cpuFx = fx.Where(e => e.Kind == FakeEffectKind.HighCpu).Sum(e => 0.55 * e.Intensity);
                var memFx = fx.Where(e => e.Kind == FakeEffectKind.HighMemory).Sum(e => 0.5 * e.Intensity);
                var kindMem = node.Kind == NodeKind.Worker ? 0.46 : 0.38;
                cpu = Math.Clamp(0.1 + 0.5 * saturation + cpuFx + (Calm ? 0 : 0.03 * Wobble(node.Id, t, 4.3)), 0.02, 1.0);
                memory = Math.Clamp(kindMem + memFx + (Calm ? 0 : 0.05 * Wobble(node.Id, t, 53)), 0.05, 1.0);
            }

            result[node.Id] = new NodeReading(now, !down, current, healthy, load, rps, errors, p99, cpu, memory, utilisation, throttled);
        }

        return Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(result);
    }

    private static bool Applies(FakeEffect e, RegistryNode n) =>
        e.Target == "*" || e.Target == n.Id || e.Target == n.GroupId;

    /// <summary>Smooth, repeatable wobble in -1..1 that differs per node.</summary>
    private static double Wobble(string id, double t, double period)
    {
        var h = StableHash(id);
        return 0.6 * Math.Sin(t / period + h % 97) + 0.4 * Math.Sin(t / (period * 0.37) + h % 31);
    }

    private static int StableHash(string s)
    {
        var h = 17;
        foreach (var c in s) h = unchecked(h * 31 + c);
        return Math.Abs(h);
    }
}
