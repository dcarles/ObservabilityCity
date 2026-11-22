var builder = DistributedApplication.CreateBuilder(args);

// The backend: snapshot API and the SignalR hub.
var host = builder.AddDotnetProject("host", "../ObservabilityCity.Host/ObservabilityCity.Host.csproj");

// The browser app (Vite dev server). The proxy target is handed over as an environment variable.
builder.AddJavaScriptApp("web", "../../../frontend", "dev")
    .WithReference(host)
    .WaitFor(host)
    .WithHttpEndpoint(env: "PORT", port: 5173)
    .WithExternalHttpEndpoints()
    .PublishAsDockerFile();

builder.Build().Run();
