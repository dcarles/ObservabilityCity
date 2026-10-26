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
    TimeProvider clock) : IMetricSource, IFakeControl, IIncidentSource
{
    // The autoscaler aims for this share of capacity, so nominal load sits mid-way and spikes push it over.
    private const double TargetUtilisation = 0.65;

    private readonly DateTimeOffset _start = clock.GetUtcNow();
    private readonly ConcurrentDictionary<string, int> _instances = new();
    private readonly ConcurrentDictionary<string, double> _backlog = new(); // messages a consumer has fallen behind by
    private readonly ConcurrentDictionary<string, double> _deadLetters = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _incidentStart = new();
    private DateTimeOffset _lastPoll;
    private readonly object _gate = new();
    private readonly List<FakeEffect> _effects = [];
    private int _nextId;

    string IIncidentSource.Name => "fake";
    public string Name => "fake";
    public TimeSpan PollInterval => options.PollInterval;

    public bool Calm { get; set; }

    public IReadOnlyList<FakeEffect> Effects
    {
        get { lock (_gate) return _effects.ToList(); }
    }

    public FakeEffect Add(string target, FakeEffectKind kind, double intensity)
    {
        if (target.Contains('#') && (kind != FakeEffectKind.Saturate || target.EndsWith('#') || target.StartsWith('#')))
            throw new ArgumentException($"'{target}': only DB saturated can be aimed at one tenant, as store#tenant", nameof(target));
        var e = new FakeEffect($"fx{Interlocked.Increment(ref _nextId)}", target, kind, Math.Clamp(intensity, 0, 1));
        lock (_gate) _effects.Add(e);
        if (kind == FakeEffectKind.Incident) _incidentStart[e.Id] = clock.GetUtcNow();
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

    public void Reset()
    {
        lock (_gate) _effects.Clear();
        _backlog.Clear();
        _deadLetters.Clear();
        _instances.Clear();
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

    /// <summary>Severity for an Incident effect's intensity: 0.85 and up is sev 1, then 0.6, 0.35, and sev 4 below.</summary>
    public static int SeverityOf(double intensity) => intensity >= 0.85 ? 1 : intensity >= 0.6 ? 2 : intensity >= 0.35 ? 3 : 4;

    public IReadOnlyList<Incident> Current(Registry registry)
    {
        var started = _start;
        var nodeGroup = registry.AllNodes.ToDictionary(n => n.Id, n => n.GroupId);
        return Effects.Where(e => e.Kind == FakeEffectKind.Incident)
            .SelectMany(e => registry.Groups
                .Where(g => e.Target == "*" || e.Target == g.Id || nodeGroup.GetValueOrDefault(e.Target) == g.Id)
                .Select(g => new Incident($"{e.Id}-{g.Id}", g.Id, SeverityOf(e.Intensity), $"Simulated sev{SeverityOf(e.Intensity)} incident", _incidentStart.GetValueOrDefault(e.Id, started))))
            .ToList();
    }

    public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry registry, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var t = (now - _start).TotalSeconds;
        var effects = Effects;
        var result = new Dictionary<string, NodeReading>();
        var dt = _lastPoll == default ? 0 : Math.Clamp((now - _lastPoll).TotalSeconds, 0, 5);
        _lastPoll = now;

        // A vendor that is down or failing makes the calls our systems send it fail too; that is also how its health would be read for real.
        var vendorTrouble = registry.Vendors.ToDictionary(v => v.Node.Id, v => VendorTrouble(effects.Where(e => Applies(e, v.Node)).ToList()));
        double CallerTrouble(string id) => registry.Vendors.Where(v => v.CalledBy.Contains(id)).Select(v => 0.4 * vendorTrouble[v.Node.Id]).DefaultIfEmpty(0).Max();

        var consumers = registry.ConsumerIds;
        var tenants = TenantsOf(registry.ActiveEnvironment);
        foreach (var node in registry.AllNodes.Concat(registry.Vendors.Select(v => v.Node)))
        {
            var isVendor = node.GroupId == RegistryVendor.GroupId;
            var p = FakeProfiles.Fill(profiles.GetValueOrDefault(node.Id), node.Kind);
            if (isVendor)
            {
                // a third party is one opaque service: no instances or CPU to see, only the calls we make to it
                p.MinInstances = p.MaxInstances = 1;
                p.PerInstanceRps = p.Rps!.Value * 2;
            }
            var fx = effects.Where(e => Applies(e, node)).ToList();
            if (fx.Any(e => e.Kind == FakeEffectKind.Stale)) continue; // the source says nothing about this node

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
            var errors = Math.Clamp(p.ErrorRate!.Value * (Calm ? 1 : 1 + 0.4 * Wobble(node.Id, t, 7)) + errorFx + CallerTrouble(node.Id), 0, 1);

            var latencyFx = fx.Where(e => e.Kind == FakeEffectKind.Latency).Sum(e => 9 * e.Intensity);
            // Latency rises a little when instances are saturated, and with load on a degraded fleet.
            var saturation = healthy > 0 ? Math.Min(2.0, rps / (healthy * p.PerInstanceRps.Value)) : 2.0;
            var p99 = p.P99Ms!.Value * (1 + latencyFx) * (0.9 + 0.2 * saturation) * (Calm ? 1 : 1 + 0.05 * Wobble(node.Id, t, 5));

            double? cpu = null, memory = null, utilisation = null, throttled = null;
            double load = down ? 0 : saturation;
            List<TenantReading>? tenantReadings = null;
            if (!down && isStore)
            {
                // A data store is provisioned for a ceiling, so what matters is how much of it is used and what gets turned away.
                var provisioned = p.Rps!.Value * 1.6;
                var saturate = fx.Where(e => e.Kind == FakeEffectKind.Saturate && e.Tenant is null).Sum(e => 0.6 * e.Intensity);
                utilisation = Math.Clamp(rps / provisioned + saturate, 0, 1.2);
                throttled = utilisation > 0.95 ? Math.Min(0.6, (utilisation.Value - 0.95) * 2.4) : 0;
                if (node.TenantPattern is not null && tenants.Count > 0)
                {
                    // one database for each tenant: it has its own share of the traffic and its own use of its own capacity
                    var weights = tenants.ToDictionary(tn => tn.Id, tn => TenantWeight(tn));
                    var sum = weights.Values.Sum();
                    tenantReadings = [];
                    foreach (var tn in tenants)
                    {
                        var skew = 0.8 + 0.4 * (StableHash(node.Id + "/" + tn.Id) % 100) / 100.0;
                        var own = fx.Where(e => e.Kind == FakeEffectKind.Saturate && e.Tenant == tn.Id).Sum(e => 0.6 * e.Intensity);
                        var u = Math.Clamp(rps / provisioned * skew + saturate + own, 0, 1.2);
                        var th = u > 0.95 ? Math.Min(0.6, (u - 0.95) * 2.4) : 0;
                        tenantReadings.Add(new TenantReading(tn.Id, u, th, rps * weights[tn.Id] / sum));
                    }
                    // the store's own numbers follow its customers; the snapshot builder works out the same from the units
                    var customers = tenantReadings.Where(r => tenants.First(tn => tn.Id == r.TenantId).Kind != TenantKind.Test).ToList();
                    if (customers.Count > 0)
                    {
                        utilisation = customers.Max(r => r.Utilisation);
                        throttled = customers.Max(r => r.Throttled);
                    }
                }
                load = utilisation!.Value;
                errors = Math.Clamp(errors + throttled!.Value * 0.2, 0, 1);
            }
            else if (!down && !isVendor)
            {
                var cpuFx = fx.Where(e => e.Kind == FakeEffectKind.HighCpu).Sum(e => 0.55 * e.Intensity);
                var memFx = fx.Where(e => e.Kind == FakeEffectKind.HighMemory).Sum(e => 0.5 * e.Intensity);
                var kindMem = node.Kind == NodeKind.Worker ? 0.46 : 0.38;
                cpu = Math.Clamp(0.1 + 0.5 * saturation + cpuFx + (Calm ? 0 : 0.03 * Wobble(node.Id, t, 4.3)), 0.02, 1.0);
                memory = Math.Clamp(kindMem + memFx + (Calm ? 0 : 0.05 * Wobble(node.Id, t, 53)), 0.05, 1.0);
            }

            double? queueDepth = null, oldest = null, deadLetters = null;
            if (node.Kind == NodeKind.Worker && consumers.Contains(node.Id))
            {
                // A consumer: messages arrive at the request rate and leave at what its healthy instances can take.
                var slow = fx.Where(e => e.Kind == FakeEffectKind.Backlog).Sum(e => 0.95 * e.Intensity);
                var serviceRate = down ? 0 : healthy * p.PerInstanceRps!.Value * (1 - Math.Clamp(slow, 0, 0.95));
                var arrival = down ? p.Rps!.Value * cycle : rps;
                var behind = _backlog.GetValueOrDefault(node.Id);
                behind = Math.Clamp(behind + (arrival - serviceRate) * dt, 0, 250_000);
                if (arrival <= serviceRate) behind = Math.Max(0, behind - 0.05 * behind * dt); // catches up faster once it can
                _backlog[node.Id] = behind;
                queueDepth = Math.Round(behind + arrival * 0.04);
                oldest = Math.Round(behind / Math.Max(1.0, serviceRate), 1);

                var poison = fx.Where(e => e.Kind == FakeEffectKind.Poison).Sum(e => 8 * e.Intensity);
                var dead = _deadLetters.GetValueOrDefault(node.Id);
                dead = Math.Max(0, dead * (1 - 0.004 * dt) + (poison + errors * rps * 0.02) * dt);
                _deadLetters[node.Id] = dead;
                deadLetters = Math.Round(dead);
            }

            result[node.Id] = new NodeReading(now, !down, current, healthy, load, rps, errors, p99, cpu, memory, utilisation, throttled, queueDepth, oldest, deadLetters, tenantReadings);
        }

        return Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(result);
    }

    /// <summary>How badly a vendor is failing, 0 to 1: all of it when down, else the error effects' rate.</summary>
    private static double VendorTrouble(List<FakeEffect> fx) =>
        fx.Any(e => e.Kind == FakeEffectKind.Down) ? 1 : fx.Where(e => e.Kind == FakeEffectKind.Errors).Select(e => 0.03 + 0.30 * e.Intensity).DefaultIfEmpty(0).Max();

    private static bool Applies(FakeEffect e, RegistryNode n) =>
        (e.Scope == "*" || e.Scope == n.Id || e.Scope == n.GroupId) && (e.Tenant is null || n.TenantPattern is not null);

    /// <summary>The tenants of the environment, then the ones the fake source "finds" in the data that the environment does not list.</summary>
    private static List<(string Id, TenantKind Kind)> TenantsOf(RegistryEnvironment? env) =>
        env is null ? [] : env.Tenants.Select(t => (t.Id, t.Kind)).Concat(env.UndeclaredTenants.Select(id => (id, TenantKind.Unknown))).ToList();

    /// <summary>How much traffic a tenant brings, relative to the others: customers differ a little, a test tenant brings next to none.</summary>
    private static double TenantWeight((string Id, TenantKind Kind) t) => t.Kind switch
    {
        TenantKind.Test => 0.08,
        TenantKind.Unknown => 0.5,
        _ => 1 + 0.6 * (StableHash(t.Id) % 100) / 100.0,
    };

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
