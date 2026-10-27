using Azure.Core;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;

namespace ObservabilityCity.Tests;

/// <summary>
/// A login that starts a process for each request (the Azure CLI one) must be asked once, not once per read: many reads at once would otherwise start many
/// processes and time out. The token is kept until shortly before it expires.
/// </summary>
public class TokenCacheTests
{
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private sealed class CountingCredential(TimeSpan lifetime, FakeTimeProvider clock, TimeSpan? delay = null, bool fail = false) : TokenCredential
    {
        private int calls;
        public int Calls => Volatile.Read(ref calls);

        public override AccessToken GetToken(TokenRequestContext context, CancellationToken ct) => throw new NotSupportedException();

        public override async ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken ct)
        {
            var n = Interlocked.Increment(ref calls);
            if (delay is { } d) await Task.Delay(d, ct);
            if (fail) throw new InvalidOperationException("no login");
            return new AccessToken($"token-{n}-{context.Scopes[0]}", clock.GetUtcNow() + lifetime);
        }
    }

    [Fact]
    public async Task Fifty_reads_at_once_start_one_sign_in()
    {
        var clock = new FakeTimeProvider(T0);
        var credential = new CountingCredential(TimeSpan.FromHours(1), clock, delay: TimeSpan.FromMilliseconds(100));
        var source = new TokenCredentialSource(credential, clock);

        var tokens = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => source.GetTokenAsync("scope-a", CancellationToken.None)));

        Assert.Equal(1, credential.Calls);
        Assert.All(tokens, t => Assert.Equal("token-1-scope-a", t));
    }

    [Fact]
    public async Task Each_scope_has_its_own_token()
    {
        var clock = new FakeTimeProvider(T0);
        var credential = new CountingCredential(TimeSpan.FromHours(1), clock);
        var source = new TokenCredentialSource(credential, clock);

        var a = await source.GetTokenAsync("scope-a", CancellationToken.None);
        var b = await source.GetTokenAsync("scope-b", CancellationToken.None);
        await source.GetTokenAsync("scope-a", CancellationToken.None);

        Assert.NotEqual(a, b);
        Assert.Equal(2, credential.Calls);
    }

    [Fact]
    public async Task A_token_is_replaced_shortly_before_it_expires_and_not_before()
    {
        var clock = new FakeTimeProvider(T0);
        var credential = new CountingCredential(TimeSpan.FromHours(1), clock);
        var source = new TokenCredentialSource(credential, clock, refreshBefore: TimeSpan.FromMinutes(5));

        await source.GetTokenAsync("scope-a", CancellationToken.None);
        clock.Advance(TimeSpan.FromMinutes(54));
        await source.GetTokenAsync("scope-a", CancellationToken.None);
        Assert.Equal(1, credential.Calls); // 6 minutes left: still kept

        clock.Advance(TimeSpan.FromMinutes(2)); // 4 minutes left: inside the margin
        var renewed = await source.GetTokenAsync("scope-a", CancellationToken.None);
        Assert.Equal(2, credential.Calls);
        Assert.Equal("token-2-scope-a", renewed);
    }

    [Fact]
    public async Task A_failed_sign_in_is_not_kept_and_the_next_read_tries_again()
    {
        var clock = new FakeTimeProvider(T0);
        var credential = new CountingCredential(TimeSpan.FromHours(1), clock, fail: true);
        var source = new TokenCredentialSource(credential, clock);

        await Assert.ThrowsAsync<InvalidOperationException>(() => source.GetTokenAsync("scope-a", CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => source.GetTokenAsync("scope-a", CancellationToken.None));

        Assert.Equal(2, credential.Calls);
    }

    [Fact]
    public async Task A_read_that_gives_up_waiting_does_not_stop_the_others()
    {
        var clock = new FakeTimeProvider(T0);
        var credential = new CountingCredential(TimeSpan.FromHours(1), clock, delay: TimeSpan.FromMilliseconds(200));
        var source = new TokenCredentialSource(credential, clock);

        var first = source.GetTokenAsync("scope-a", CancellationToken.None);
        using var gaveUp = new CancellationTokenSource(TimeSpan.FromMilliseconds(20));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.GetTokenAsync("scope-a", gaveUp.Token));

        Assert.Equal("token-1-scope-a", await first);
        Assert.Equal(1, credential.Calls);
    }
}
