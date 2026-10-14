import http from "node:http";
import net from "node:net";

const DOCKER_SOCKET =
  process.env.DOCKER_SOCKET ||
  (process.platform === "win32"
    ? "//./pipe/docker_engine"
    : "/var/run/docker.sock");

export function dockerApiRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: {
          ...(postData
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 200, data });
        });
      },
    );

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

export function resizeDockerExec(
  execId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: `/exec/${execId}/resize?w=${cols}&h=${rows}`,
        method: "POST",
      },
      () => resolve(),
    );
    req.on("error", () => resolve());
    req.end();
  });
}

export function startAndHijackExec(execId: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const startPayload = JSON.stringify({ Detach: false, Tty: true });
    const req = http.request({
      socketPath: DOCKER_SOCKET,
      path: `/exec/${execId}/start`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });

    req.on("upgrade", (_res, socket) => {
      resolve(socket as net.Socket);
    });

    req.on("response", (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let errData = "";
        res.on("data", (c) => (errData += c));
        res.on("end", () =>
          reject(new Error(`Failed to start exec: ${errData}`)),
        );
      } else {
        resolve(res.socket as net.Socket);
      }
    });

    req.on("error", reject);
    req.end(startPayload);
  });
}
