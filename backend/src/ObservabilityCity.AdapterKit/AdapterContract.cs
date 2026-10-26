using System.Text.RegularExpressions;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.AdapterKit;

/// <summary>Raised when an adapter breaks one of the rules every adapter keeps. The message lists all of them.</summary>
public sealed class ContractViolation(IReadOnlyList<string> problems) : Exception("The adapter breaks " + problems.Count + " rule(s):" + Environment.NewLine + "  - " + string.Join(Environment.NewLine + "  - ", problems))
{
    public IReadOnlyList<string> Problems { get; } = problems;
}

/// <summary>
/// The rules every adapter keeps, as checks. Each <c>Check</c> returns the problems in words; each <c>Assert</c> throws a <see cref="ContractViolation"/> if
/// there are any, so it works in any test framework. They check what the town relies on: a module registers cleanly under names the registry can spell,
/// a source has a poll interval and a timeout, answers only for systems the registry has, gives numbers that mean what the snapshot builder assumes, and
/// gives up when it is told to stop.
/// </summary>
public static partial class AdapterContract
{
    [GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial Regex Kebab();

    public static IReadOnlyList<string> CheckModule(IAdapterModule module)
    {
        var problems = new List<string>();
        if (!Kebab().IsMatch(module.Name)) problems.Add($"the module's Name '{module.Name}' must be lowercase kebab-case: it names the adapter in start-up messages");
        var catalog = new Recorder(problems);
        try { module.Register(catalog); }
        catch (Exception e) { problems.Add($"Register threw {e.GetType().Name}: {e.Message}. Registering must only record what the module has; it signs nobody in and reaches nothing"); }
        if (catalog.Kinds.Count == 0 && catalog.Logins.Count == 0) problems.Add("the module registers no source kind and no login, so it adds nothing");
        foreach (var kind in catalog.Kinds.Concat(catalog.Factories).Concat(catalog.Logins).Distinct())
            if (!Kebab().IsMatch(kind)) problems.Add($"'{kind}' must be lowercase kebab-case, because it is written in environment files");
        foreach (var duplicate in catalog.Factories.GroupBy(k => k).Where(g => g.Count() > 1))
            problems.Add($"two factories are registered for the kind '{duplicate.Key}'; the second would silently replace the first");
        return problems;
    }

    public static void AssertModule(IAdapterModule module) => Raise(CheckModule(module));

    /// <summary>The checks on a source before it is polled: how often it is asked and how long it may take.</summary>
    public static IReadOnlyList<string> CheckSource(IMetricSource source)
    {
        var problems = new List<string>();
        if (string.IsNullOrWhiteSpace(source.Name)) problems.Add("the source has no Name");
        if (source.PollInterval <= TimeSpan.Zero) problems.Add($"PollInterval is {source.PollInterval}; it must be above zero or the poller would spin");
        if (source.Timeout <= TimeSpan.Zero) problems.Add($"Timeout is {source.Timeout}; it must be above zero or every poll would be cancelled at once");
        return problems;
    }

    /// <summary>
    /// Polls the source once against a registry and checks the answer and the manners: readings only for systems the registry has and with sane numbers,
    /// and a poll that is cancelled ends (with <see cref="OperationCanceledException"/> or an answer) instead of hanging.
    /// </summary>
    public static async Task<IReadOnlyList<string>> CheckPollAsync(IMetricSource source, Registry registry, TimeSpan? patience = null)
    {
        var problems = CheckSource(source).ToList();
        var wait = patience ?? TimeSpan.FromSeconds(10);
        using (var limit = new CancellationTokenSource(wait))
        {
            var polling = Task.Run(() => source.PollAsync(registry, limit.Token));
            if (await Task.WhenAny(polling, Task.Delay(wait)) != polling)
                problems.Add($"a poll took longer than {wait} and was told to stop; the adapter's calls must honour the cancellation token it is given");
            else
                try { problems.AddRange(CheckReadings(await polling, registry)); }
                catch (Exception e) { problems.Add($"the poll threw {e.GetType().Name}: {e.Message}"); }
        }
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var ending = Task.Run(() => source.PollAsync(registry, cancelled.Token));
        if (await Task.WhenAny(ending, Task.Delay(wait)) != ending)
            problems.Add("a poll given a token that was already cancelled did not end; pass the token to every call the adapter makes");
        else
            try { await ending; }
            catch (Exception) { /* cancelling it, or failing, both end it, which is all that is asked here */ }
        return problems;
    }

    public static async Task AssertPollAsync(IMetricSource source, Registry registry) => Raise(await CheckPollAsync(source, registry));

    /// <summary>What a source may report: a number for a system the registry has, with rates at or above zero and shares between 0 and 1.</summary>
    public static IReadOnlyList<string> CheckReadings(IReadOnlyDictionary<string, NodeReading> readings, Registry registry)
    {
        var problems = new List<string>();
        var known = registry.AllNodes.Select(n => n.Id).Concat(registry.Vendors.Select(v => v.Node.Id)).ToHashSet();
        foreach (var (id, r) in readings)
        {
            if (!known.Contains(id)) { problems.Add($"a reading for '{id}', which the registry does not have; leave out what you cannot place"); continue; }
            void Rule(bool ok, string message) { if (!ok) problems.Add($"{id}: {message}"); }
            Rule(r.At != default, "At is not set; the reading would age as if it were from year one and show as stale");
            Rule(r.InstancesTotal >= 0, $"InstancesTotal is {r.InstancesTotal}");
            Rule(r.InstancesHealthy >= 0 && r.InstancesHealthy <= r.InstancesTotal, $"InstancesHealthy is {r.InstancesHealthy} of {r.InstancesTotal}");
            Rule(r.RequestsPerSecond >= 0, $"RequestsPerSecond is {r.RequestsPerSecond}");
            Rule(r.ErrorRate is >= 0 and <= 1, $"ErrorRate is {r.ErrorRate}; it is a share between 0 and 1");
            Rule(r.P99Ms >= 0, $"P99Ms is {r.P99Ms}");
            Rule(r.Load >= 0, $"Load is {r.Load}");
            foreach (var (name, value) in new[] { ("Cpu", r.Cpu), ("Memory", r.Memory), ("Utilisation", r.Utilisation), ("Throttled", r.Throttled) })
                Rule(value is null or (>= 0 and <= 1), $"{name} is {value}; it is a share between 0 and 1, or null when the source does not know");
            foreach (var (name, value) in new[] { ("QueueDepth", r.QueueDepth), ("OldestMessageSeconds", r.OldestMessageSeconds), ("DeadLetters", r.DeadLetters) })
                Rule(value is null or >= 0, $"{name} is {value}; it cannot be negative");
            foreach (var t in r.Tenants ?? [])
                Rule(t.TenantId.Length > 0 && t.RequestsPerSecond >= 0 && t.Utilisation is null or (>= 0 and <= 1) && t.Throttled is null or (>= 0 and <= 1), $"tenant '{t.TenantId}' has a number out of range");
        }
        return problems;
    }

    public static void AssertReadings(IReadOnlyDictionary<string, NodeReading> readings, Registry registry) => Raise(CheckReadings(readings, registry));

    private static void Raise(IReadOnlyList<string> problems)
    {
        if (problems.Count > 0) throw new ContractViolation(problems);
    }

    private sealed class Recorder(List<string> problems) : IAdapterRegistry
    {
        public HashSet<string> Kinds { get; } = [];
        public List<string> Factories { get; } = [];
        public List<string> Logins { get; } = [];

        public void AddSourceKind(SourceKindInfo kind) => Kinds.Add(kind.Kind);

        public void AddSource(IMetricSourceFactory factory)
        {
            if (string.IsNullOrEmpty(factory.Kind)) problems.Add("a source factory has no Kind");
            Factories.Add(factory.Kind);
            Kinds.Add(factory.Kind);
        }

        public void AddCredentialKind(ICredentialKind kind) => Logins.Add(kind.Kind);
    }
}
