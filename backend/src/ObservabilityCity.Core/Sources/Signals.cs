namespace ObservabilityCity.Core.Sources;

/// <summary>
/// The signals a building can show, named the way the registry spells them. They are what a source fills, whatever the source is: the town knows
/// request rate, not Prometheus or Log Analytics. A signal with no source is absent (see <see cref="Registry.Registry.AbsentSignals"/>).
/// </summary>
public static class Signals
{
    public const string Requests = "requests";
    public const string Errors = "errors";
    public const string Latency = "latency";
    public const string Instances = "instances";
    public const string Cpu = "cpu";
    public const string Memory = "memory";
    public const string Utilisation = "utilisation";
    public const string Throttled = "throttled";
    public const string Backlog = "backlog";
    public const string DeadLetters = "deadLetters";

    /// <summary>The scheduled jobs of a function building: when each last ran and whether it succeeded. Only a function has this signal.</summary>
    public const string Jobs = "jobs";

    public static readonly string[] All =
        [Requests, Errors, Latency, Instances, Cpu, Memory, Utilisation, Throttled, Backlog, DeadLetters];

    /// <summary>The signals every kind of system has, plus <see cref="Jobs"/> for a function.</summary>
    public static IReadOnlyList<string> For(Contracts.NodeKind kind) => kind == Contracts.NodeKind.Function ? [.. All, Jobs] : All;

    /// <summary>Every name a registry file may use for a signal.</summary>
    public static readonly string[] Known = [.. All, Jobs];

    /// <summary>Written in an environment's <c>signals</c> or a pillar's or system's to say that a signal has no source there, whatever the environment's default.</summary>
    public const string None = "none";

    /// <summary>
    /// The environment source a signal comes from when nothing names one: the source called "messaging" for the queue signals, the one called
    /// "metrics" for the rest. These are the names environment files have always used, so they keep working.
    /// </summary>
    public static string DefaultSourceName(string signal) => signal is Backlog or DeadLetters ? "messaging" : signal == Jobs ? "jobs" : "metrics";
}
