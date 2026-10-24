import {
  formatDiscordPayload,
  formatSlackPayload,
  formatTelegramPayload,
  isNotificationEventEnabled,
  resolveTelegramDetails,
  type NotificationConfig,
  type NotificationPayload,
  logger,
  PRODUCT_NAME,
} from "@explita/infra-protocol";
import { FormattedApp } from "./formatters/app.js";

export interface SendResult {
  discord?: boolean;
  slack?: boolean;
  telegram?: boolean;
  errors: string[];
}

export class NotificationService {
  /**
   * Dispatches a notification for an event to all configured channels for the app.
   */
  public async notify(
    payload: NotificationPayload,
    app: FormattedApp,
  ): Promise<SendResult> {
    const config = app.metadata?.notify;

    if (!config) {
      return { errors: [] };
    }

    if (!isNotificationEventEnabled(config, payload.event)) {
      return { errors: [] };
    }

    return this.dispatch(payload, config);
  }

  /**
   * Directly dispatches payload to the given NotificationConfig.
   */
  public async dispatch(
    payload: NotificationPayload,
    config: NotificationConfig,
  ): Promise<SendResult> {
    const result: SendResult = { errors: [] };
    const tasks: Promise<void>[] = [];

    // 1. Discord
    if (config.discord) {
      tasks.push(
        (async () => {
          try {
            const body = formatDiscordPayload(payload);
            const res = await fetch(config.discord!, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(6000),
            });

            if (!res.ok) {
              const text = await res.text().catch(() => "");
              const msg = `Discord webhook returned status ${res.status}: ${text.slice(0, 200)}`;
              logger.warn(`[notify] ${msg}`);
              result.errors.push(msg);
              result.discord = false;
            } else {
              result.discord = true;
            }
          } catch (err) {
            const msg = `Discord webhook error: ${err instanceof Error ? err.message : String(err)}`;
            logger.warn(`[notify] ${msg}`);
            result.errors.push(msg);
            result.discord = false;
          }
        })(),
      );
    }

    // 2. Slack
    if (config.slack) {
      tasks.push(
        (async () => {
          try {
            const body = formatSlackPayload(payload);
            const res = await fetch(config.slack!, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(6000),
            });

            if (!res.ok) {
              const text = await res.text().catch(() => "");
              const msg = `Slack webhook returned status ${res.status}: ${text.slice(0, 200)}`;
              logger.warn(`[notify] ${msg}`);
              result.errors.push(msg);
              result.slack = false;
            } else {
              result.slack = true;
            }
          } catch (err) {
            const msg = `Slack webhook error: ${err instanceof Error ? err.message : String(err)}`;
            logger.warn(`[notify] ${msg}`);
            result.errors.push(msg);
            result.slack = false;
          }
        })(),
      );
    }

    // 3. Telegram
    if (config.telegram) {
      tasks.push(
        (async () => {
          try {
            const { chatId, token } = resolveTelegramDetails(config);

            if (!chatId) {
              const msg = "Telegram chatId is not configured.";
              logger.warn(`[notify] ${msg}`);
              result.errors.push(msg);
              result.telegram = false;
              return;
            }

            if (!token) {
              const msg =
                "Telegram bot token is missing. Configure token or set EXPLITA_TELEGRAM_BOT_TOKEN.";
              logger.warn(`[notify] ${msg}`);
              result.errors.push(msg);
              result.telegram = false;
              return;
            }

            const body = formatTelegramPayload(payload, chatId);
            const url = `https://api.telegram.org/bot${token}/sendMessage`;

            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(6000),
            });

            if (!res.ok) {
              const text = await res.text().catch(() => "");
              const msg = `Telegram API returned status ${res.status}: ${text.slice(0, 200)}`;
              logger.warn(`[notify] ${msg}`);
              result.errors.push(msg);
              result.telegram = false;
            } else {
              result.telegram = true;
            }
          } catch (err) {
            const msg = `Telegram error: ${err instanceof Error ? err.message : String(err)}`;
            logger.warn(`[notify] ${msg}`);
            result.errors.push(msg);
            result.telegram = false;
          }
        })(),
      );
    }

    await Promise.all(tasks);
    return result;
  }

  /**
   * Sends a test alert payload to all configured channels.
   */
  public async sendTest(
    config: NotificationConfig,
    app: { id: string; name: string },
  ): Promise<SendResult> {
    const payload: NotificationPayload = {
      event: "container_healthy",
      title: `🔔 ${PRODUCT_NAME.deploy} Alerts Test`,
      level: "info",
      appName: app.name,
      appId: app.id,
      description: `Success! Your notification channels are connected to ${PRODUCT_NAME.deploy}.`,
      details: {
        serverTime: new Date().toISOString(),
        configuredChannels: [
          config.discord ? "Discord" : null,
          config.slack ? "Slack" : null,
          config.telegram ? "Telegram" : null,
        ]
          .filter(Boolean)
          .join(", "),
      },
    };

    return this.dispatch(payload, config);
  }
}

export const notificationService = new NotificationService();
