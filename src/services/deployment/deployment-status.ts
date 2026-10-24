import { FastifyRequest } from "fastify";
import { deployer } from "../../lib/deployer.js";
import { prisma } from "../../lib/prisma.js";
import { formatDeployment } from "../../lib/formatters/deployment.js";
import { WebSocket } from "@fastify/websocket";
import {
  ActiveDeploymentState,
  isTerminalStatus,
} from "@explita/infra-protocol/deploy";

export async function deploymentStatus(
  socket: WebSocket,
  request: FastifyRequest,
) {
  const id = request.params?.id;
  if (!id) {
    socket.send(JSON.stringify({ error: "Deployment not found" }));
    socket.close();
    return;
  }

  const active = deployer.getActive(id);
  if (active) {
    socket.send(JSON.stringify({ type: "snapshot", deployment: active }));

    const onUpdate = (updatedState: ActiveDeploymentState) => {
      try {
        socket.send(
          JSON.stringify({ type: "update", deployment: updatedState }),
        );
        if (isTerminalStatus(updatedState.status)) {
          cleanup();
          socket.close();
        }
      } catch {
        cleanup();
      }
    };

    const cleanup = () => {
      deployer.events.off(`update:${id}`, onUpdate);
    };

    deployer.events.on(`update:${id}`, onUpdate);
    socket.on("close", cleanup);
    return;
  }

  const deployment = await prisma.deployment.findUnique({
    where: { id },
    include: { log: true },
  });
  if (!deployment) {
    socket.send(JSON.stringify({ error: "Deployment not found" }));
    socket.close();
    return;
  }

  socket.send(
    JSON.stringify({
      type: "snapshot",
      deployment: formatDeployment(deployment),
    }),
  );
  socket.close();
}
