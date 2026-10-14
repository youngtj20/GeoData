// PM2 process config. .cjs (not .js) because package.json sets "type": "module" — PM2 config files are
// loaded as CommonJS, and a plain .js here would be parsed as ESM and fail on `module.exports`.
//
// Usage:
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save && pm2 startup   # persist across reboots
//
// Requires dist/index.js to exist first — run `npm run build`.
module.exports = {
  apps: [
    {
      name: "groundtruth-server",
      script: "dist/index.js",
      // Node's native --env-file (stable since Node 20.6) — same mechanism the dev/start npm scripts already
      // use, just pointed at a production env file instead of .env.local. Keep .env.production out of git,
      // same as .env.local.
      node_args: "--env-file=.env.production",
      cwd: __dirname,

      // stateless auth (JWT for the admin UI, DB-backed API keys for 3rd parties) — no in-process session
      // state, so cluster mode is safe whenever you want it: bump instances to "max" and exec_mode to
      // "cluster" to use every core behind PM2's built-in load balancer. Starting at 1/fork is the safe default.
      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s", // a restart loop (e.g. bad DB creds) stops being retried after enough rapid failures
      restart_delay: 3000,

      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
