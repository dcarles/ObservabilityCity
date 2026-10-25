namespace ObservabilityCity.Core.Registry;

// Shapes of the YAML files, as read from disk. RegistryLoader turns them into the Registry model.

internal sealed class TownFile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string GroupLabel { get; set; } = "Group";
    public string Topology { get; set; } = "direct";
}

internal sealed class ErrorThresholdsFile
{
    public double? Amber { get; set; }
    public double? Red { get; set; }
}

internal sealed class RoleDefaultsFile
{
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
    /// <summary>When CPU, memory or a data store's utilisation turns amber and red (0 to 1).</summary>
    public ErrorThresholdsFile? Resources { get; set; }
    /// <summary>The same for the share of throttled requests.</summary>
    public ErrorThresholdsFile? Throttle { get; set; }
    /// <summary>When the oldest waiting message of a consumer turns amber and red, in seconds.</summary>
    public ErrorThresholdsFile? Backlog { get; set; }
}

/// <summary>defaults.yaml and the "defaults" block of a pillar file: role name to defaults.</summary>
internal sealed class DefaultsFile : Dictionary<string, RoleDefaultsFile>;

internal sealed class SystemFile
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    public string? Role { get; set; }
    /// <summary>Systems that share a service name are drawn together as one block.</summary>
    public string? Service { get; set; }
    public bool? External { get; set; }
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
    public ErrorThresholdsFile? Resources { get; set; }
    public ErrorThresholdsFile? Throttle { get; set; }
    public ErrorThresholdsFile? Backlog { get; set; }
    /// <summary>Ids of the systems this one calls directly. Cars drive only along declared links.</summary>
    public List<string> Calls { get; set; } = [];
    /// <summary>Ids of systems on other islands this one reaches through the API gateway (the way calls between islands go in a hub-and-spoke town).</summary>
    public List<string> GatewayCalls { get; set; } = [];
    /// <summary>Former ids of this system. Other files may still call it by one of them.</summary>
    public List<string> Aliases { get; set; } = [];
}

internal sealed class PillarFile
{
    public string Pillar { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Color { get; set; } = "#8ab4ff";
    public bool External { get; set; }
    public DefaultsFile Defaults { get; set; } = new();
    public List<SystemFile> Systems { get; set; } = [];
}

internal sealed class HubFile
{
    public string DisplayName { get; set; } = "Hub";
    public string Color { get; set; } = "#f5c26b";
    public List<SystemFile> Resources { get; set; } = [];
    public List<ExternalCallerFile> ExternalCallers { get; set; } = [];
}

internal sealed class ExternalCallerFile
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    public List<string> Calls { get; set; } = [];
}

/// <summary>layout.yaml: the order of the islands round the hub.</summary>
internal sealed class LayoutFile
{
    public List<string> Islands { get; set; } = [];
}

/// <summary>third-parties.yaml: the vendors outside the town and which of our systems call each one.</summary>
internal sealed class ThirdPartiesFile
{
    public List<VendorFile> Vendors { get; set; } = [];
}

internal sealed class VendorFile
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    /// <summary>Ids of our systems that call this vendor. Its health is read from those calls.</summary>
    public List<string> CalledBy { get; set; } = [];
    public double? SlaP99Ms { get; set; }
    public ErrorThresholdsFile? Errors { get; set; }
}
