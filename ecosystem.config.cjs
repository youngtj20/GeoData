// PM2 config for the frontend static build. .cjs because package.json sets "type": "module".
//
// Usage:
//   npm run build        # produces dist/ — run this again after any source change, then `pm2 reload`
//   pm2 start ecosystem.config.cjs
//
// Runs `vite preview` (serves the built dist/ output) rather than `vite` (the dev/HMR server) — same
// "compiled and kept alive" treatment as server/ecosystem.config.cjs runs dist/index.js instead of tsx watch.
// Trade-off: no hot-reload: a source change needs a rebuild + `pm2 reload geodata-frontend` to show up.
module.exports = {
  apps: [
    {
      name: "geodata-frontend",
      // the plain .js entry (not the node_modules/.bin shim) — the shim is a platform-specific cmd/shell
      // wrapper on Windows that PM2 can't exec directly; this is a real Node script, OS-agnostic
      script: "node_modules/vite/bin/vite.js",
      args: "preview --host --port 4173",
      cwd: __dirname,

      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,
    },
  ],
};
