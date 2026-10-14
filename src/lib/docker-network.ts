import { docker } from "./constants.js";
import { run } from "./runner.js";

export async function ensureDockerNetwork(
  name: string = docker.network,
): Promise<void> {
  const check = await run("docker", ["network", "inspect", name]);

  if (check.code !== 0) {
    const created = await run("docker", ["network", "create", name]);
    if (created.code !== 0) {
      throw new Error(
        `Failed to create docker network ${name}: ${created.stderr || created.stdout}`,
      );
    }
  }
}
