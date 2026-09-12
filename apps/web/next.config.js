/** @type {import('next').NextConfig} */
const nextConfig = {
  // The finance provider reads the archive through node-postgres. Leave it to
  // Node rather than bundling it: `pg` loads optional native bindings the
  // bundler cannot resolve.
  serverExternalPackages: ["pg"],
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/mcp/oauth-metadata",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/mcp/oauth-protected-resource",
      },
      {
        source: "/.well-known/mcp.json",
        destination: "/api/mcp/discovery",
      },
    ];
  },
};

export default nextConfig;
