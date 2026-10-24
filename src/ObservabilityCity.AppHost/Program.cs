var builder = DistributedApplication.CreateBuilder(args);

// The backend: snapshot API and the SignalR hub.
var host = builder.AddProject<Projects.ObservabilityCity_Host>("host");

// The browser app (Vite dev server). The proxy target is handed over as an environment variable.
builder.AddNpmApp("web", "../../web", "dev")
    .WithReference(host)
    .WaitFor(host)
    .WithHttpEndpoint(env: "PORT", port: 5173)
    .WithExternalHttpEndpoints()
    .PublishAsDockerFile();

builder.Build().Run();
