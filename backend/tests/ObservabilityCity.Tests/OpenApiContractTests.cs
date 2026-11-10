using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using ObservabilityCity.Host;

namespace ObservabilityCity.Tests;

/// <summary>
/// The OpenAPI document is the bridge to the generated TypeScript types, so its shape is pinned here: what is required, what stays optional,
/// how numbers and enums are described. (CI also fails when the committed contracts/openapi.json and contracts.ts differ from a fresh run.)
/// </summary>
public class OpenApiContractTests
{
    private static async Task<JsonElement> Schemas()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("environment", "Development");
            b.UseSetting("Registry:Path", TestPaths.MiniTown);
            b.UseSetting("Registry:WatchSeconds", "0");
        });
        var json = await factory.CreateClient().GetStringAsync("/openapi/v1.json");
        return JsonDocument.Parse(json).RootElement.GetProperty("components").GetProperty("schemas").Clone();
    }

    private static string[] Required(JsonElement schema) =>
        schema.TryGetProperty("required", out var r) ? r.EnumerateArray().Select(e => e.GetString()!).ToArray() : [];

    [Fact]
    public async Task Every_property_that_cannot_be_null_is_required()
    {
        var schemas = await Schemas();
        foreach (var schema in schemas.EnumerateObject().Where(s => s.Value.TryGetProperty("properties", out _)))
        {
            var required = Required(schema.Value);
            foreach (var prop in schema.Value.GetProperty("properties").EnumerateObject())
                if (prop.Name is not ("scope" or "link" or "level" or "app" or "engine" or "flow" or "wall")) // the nullable ones below
                    if (!schema.Value.GetProperty("properties").GetProperty(prop.Name).TryGetProperty("nullable", out _))
                        Assert.Contains(prop.Name, required);
        }
    }

    [Fact]
    public async Task A_nullable_property_stays_optional_and_a_nullable_record_reference_is_a_plain_reference()
    {
        var schemas = await Schemas();
        var node = schemas.GetProperty("NodeSnapshot");
        Assert.DoesNotContain("app", Required(node));
        Assert.Contains("state", Required(node));
        Assert.Equal("#/components/schemas/AppState", node.GetProperty("properties").GetProperty("app").GetProperty("$ref").GetString());
        Assert.DoesNotContain("link", Required(schemas.GetProperty("QueueSnapshot")));
        Assert.Equal("#/components/schemas/ResourceLink", schemas.GetProperty("QueueSnapshot").GetProperty("properties").GetProperty("link").GetProperty("$ref").GetString());
    }

    [Fact]
    public async Task Numbers_are_plain_numbers_and_enums_are_strings_without_a_null_member()
    {
        var schemas = await Schemas();
        foreach (var schema in schemas.EnumerateObject())
        {
            if (schema.Value.TryGetProperty("enum", out var members))
            {
                Assert.Equal("string", schema.Value.GetProperty("type").GetString());
                Assert.All(members.EnumerateArray(), m => Assert.Equal(JsonValueKind.String, m.ValueKind));
            }
            if (!schema.Value.TryGetProperty("properties", out var props)) continue;
            foreach (var prop in props.EnumerateObject())
            {
                Assert.False(prop.Value.TryGetProperty("pattern", out _), $"{schema.Name}.{prop.Name} accepts numbers as text");
                Assert.False(prop.Value.TryGetProperty("default", out _), $"{schema.Name}.{prop.Name} has a default");
                if (prop.Value.TryGetProperty("type", out var type)) Assert.Equal(JsonValueKind.String, type.ValueKind); // one type, not "number or string"
            }
        }
    }
}
