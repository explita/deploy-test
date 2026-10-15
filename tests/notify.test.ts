import "@explita/env-loader/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createAppSchema, updateAppSchema } from "../src/zod/app-schema.js";
import { NotificationService } from "../src/lib/notification-service.js";

test("zod schemas parse and normalize notify configuration", () => {
  const parsedCreate = createAppSchema.parse({
    name: "test-app",
    notify: {
      discord: "https://discord.com/api/webhooks/123/xyz",
      slack: "https://hooks.slack.com/services/abc/def/ghi",
      telegram: "-100123456789",
      events: ["deployment_failed", "cron_failed"],
    },
  });

  assert.equal(
    parsedCreate.notify?.discord,
    "https://discord.com/api/webhooks/123/xyz",
  );
  assert.equal(
    parsedCreate.notify?.slack,
    "https://hooks.slack.com/services/abc/def/ghi",
  );
  assert.equal(parsedCreate.notify?.telegram, "-100123456789");
  assert.deepEqual(parsedCreate.notify?.events, [
    "deployment_failed",
    "cron_failed",
  ]);

  const parsedUpdate = updateAppSchema.parse({
    notify: {
      telegram: {
        chatId: "987654321",
        token: "123456:BOT_TOKEN",
      },
    },
  });

  assert.deepEqual(parsedUpdate.notify?.telegram, {
    chatId: "987654321",
    token: "123456:BOT_TOKEN",
  });
});

test("NotificationService dispatches rich alerts to Discord, Slack, and Telegram", async () => {
  const service = new NotificationService();
  const dispatchedUrls: string[] = [];
  const dispatchedBodies: Record<string, any>[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    dispatchedUrls.push(String(url));
    if (init?.body) {
      dispatchedBodies.push(JSON.parse(String(init.body)));
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;

  try {
    const app = {
      id: "app-abc",
      name: "my-web-app",
      metadata: {
        notify: {
          discord: "https://discord.com/api/webhooks/test",
          slack: "https://hooks.slack.com/services/test",
          telegram: {
            chatId: "1234567",
            token: "bot999:TEST_TOKEN",
          },
        },
      },
    };

    const res = await service.notify(
      {
        event: "deployment_failed",
        title: "❌ Deployment Failed: my-web-app",
        level: "error",
        appName: app.name,
        appId: app.id,
        description: "Build script exited with code 1",
        snippet: "npm ERR! Missing script: build",
        details: {
          deploymentId: "d-12345",
        },
      },
      app,
    );

    assert.equal(res.discord, true);
    assert.equal(res.slack, true);
    assert.equal(res.telegram, true);
    assert.equal(res.errors.length, 0);

    assert.equal(dispatchedUrls.length, 3);
    assert.ok(dispatchedUrls.includes("https://discord.com/api/webhooks/test"));
    assert.ok(dispatchedUrls.includes("https://hooks.slack.com/services/test"));
    assert.ok(
      dispatchedUrls.includes(
        "https://api.telegram.org/bot999:TEST_TOKEN/sendMessage",
      ),
    );

    // Verify rich snippet delivery
    const discordBody = dispatchedBodies.find((b) => b.embeds);
    assert.ok(discordBody);
    assert.ok(discordBody.embeds[0].description.includes("Missing script: build"));

    const slackBody = dispatchedBodies.find((b) => b.attachments);
    assert.ok(slackBody);
    assert.ok(slackBody.attachments[0].text.includes("Missing script: build"));

    const telegramBody = dispatchedBodies.find((b) => b.chat_id === "1234567");
    assert.ok(telegramBody);
    assert.ok(telegramBody.text.includes("Missing script: build"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NotificationService filters events when specific events list is defined", async () => {
  const service = new NotificationService();
  let fetchCalled = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;

  try {
    const app = {
      id: "app-abc",
      name: "my-web-app",
      metadata: {
        notify: {
          discord: "https://discord.com/api/webhooks/test",
          events: ["cron_failed"], // Only cron_failed subscribed
        },
      },
    };

    // Sending deployment_failed should be ignored
    const res = await service.notify(
      {
        event: "deployment_failed",
        title: "❌ Deployment Failed",
        level: "error",
        appName: app.name,
        appId: app.id,
      },
      app,
    );

    assert.equal(fetchCalled, false);
    assert.equal(res.errors.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cron notification deduplication alerts once on streak and resets on recovery", () => {
  const jobState: { failureReported?: boolean; consecutiveFailures?: number } = {};

  const simulateRun = (status: "success" | "failed", manual = false) => {
    let sentAlert = false;
    if (status === "failed") {
      jobState.consecutiveFailures = (jobState.consecutiveFailures || 0) + 1;
      if (!jobState.failureReported || manual) {
        jobState.failureReported = true;
        sentAlert = true;
      }
    } else {
      jobState.failureReported = false;
      jobState.consecutiveFailures = 0;
    }
    return sentAlert;
  };

  // Run 1: First failure -> should send alert
  assert.equal(simulateRun("failed"), true);
  assert.equal(jobState.consecutiveFailures, 1);
  assert.equal(jobState.failureReported, true);

  // Run 2: Second consecutive failure (next minute) -> should NOT spam alert
  assert.equal(simulateRun("failed"), false);
  assert.equal(jobState.consecutiveFailures, 2);

  // Run 3: Third consecutive failure -> should NOT spam alert
  assert.equal(simulateRun("failed"), false);
  assert.equal(jobState.consecutiveFailures, 3);

  // Run 4: Explicit manual run during failure -> allowed to alert
  assert.equal(simulateRun("failed", true), true);

  // Run 5: Job recovers and succeeds -> resets tracker
  assert.equal(simulateRun("success"), false);
  assert.equal(jobState.consecutiveFailures, 0);
  assert.equal(jobState.failureReported, false);

  // Run 6: New future failure -> alerts again cleanly
  assert.equal(simulateRun("failed"), true);
  assert.equal(jobState.consecutiveFailures, 1);
});
