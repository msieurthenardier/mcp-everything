import { configDefaults, defineConfig } from "vitest/config";

/**
 * Two projects. `default` is the fast unit run (`npm test`); `slow` holds the two files that take real time (`npm run test:slow`):
 * real sockets in `proxy-server.test.ts`, and the walk and probe scripts run in a local shell in `docker-shell.test.ts`.
 * A bare `npx vitest run` runs both, and so does CI. The integration files stay in `default`, still gated by `MCPE_DOCKER_TESTS`.
 */
const SLOW = ["test/proxy-server.test.ts", "test/docker-shell.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "default",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...SLOW],
        },
      },
      {
        test: {
          name: "slow",
          include: SLOW,
        },
      },
    ],
  },
});
